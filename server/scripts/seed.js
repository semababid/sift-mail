import mongoose from 'mongoose';
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import { User, Thread, Message, Label, RefreshToken, IntentLabel } from '../src/models/index.js';
import { register } from '../src/services/auth.service.js';
import { makeRng } from '../src/lib/random.js';
import { normalizeSubject, makeSnippet } from '../src/lib/text.js';
import { SENDERS, THREADS, FILLER_SUBJECTS, FILLER_BODIES, FILLER_REPLIES } from './seed-data.js';

const { values: opts } = parseArgs({
  options: {
    email: { type: 'string', default: 'semab@sift.example' },
    password: { type: 'string', default: 'correct-horse' },
    name: { type: 'string', default: 'Semab' },
    threads: { type: 'string', default: '1200' },
    seed: { type: 'string', default: '42' },
    days: { type: 'string', default: '180' },
    reset: { type: 'boolean', default: false },
    // Pins the clock. Without it the same seed gives the same messages but
    // different dates on different days, and the tests cannot check behaviour
    // that depends on the time of day the script happens to run.
    now: { type: 'string' },
  },
});

// Refused up front. A count that is not a number used to seed an empty
// mailbox and exit 0, which a test then read as a mailbox with nothing in it.
const positiveInt = (name, value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number above 0, got ${JSON.stringify(value)}`);
  return n;
};
const threadCount = positiveInt('threads', opts.threads);
const spanDays = positiveInt('days', opts.days);
const rng = makeRng(Number(opts.seed));
const NOW = opts.now ? Date.parse(opts.now) : Date.now();
if (Number.isNaN(NOW)) throw new Error(`--now is not a date: ${opts.now}`);

const LABELS = [
  { name: 'Wohnung', color: '#0ea5e9' },
  { name: 'Uni', color: '#8b5cf6' },
  { name: 'Bewerbungen', color: '#f59e0b' },
  { name: 'Rechnungen', color: '#ef4444' },
];

// Everything here works in UTC. Setting hours in local time and then asserting
// on them with Mongo's $hour compares two different clocks, and in Berlin that
// is a two hour lie in summer.
const DAY_START = 6;
const DAY_END = 20;

// Mail does not arrive evenly. Weight the recent end so the top of the inbox is
// dense and the tail thins out, which is what paging through a real mailbox
// feels like.
function randomSentAt() {
  const skewed = rng.next() ** 2.2;
  const at = new Date(NOW - skewed * spanDays * 86_400_000);
  // Office hours, roughly. Mail timestamped 04:00 looks synthetic.
  at.setUTCHours(rng.int(DAY_START, DAY_END), rng.int(0, 59), rng.int(0, 59), 0);
  // Picking an hour on today's date can land later than now: at 07:30 there is
  // a whole afternoon still ahead. Threads get shifted back afterwards, but a
  // draft is a single message with nothing after it to trigger that, so the
  // clamp has to happen here. A day back keeps the hour it picked.
  if (at.getTime() > NOW) at.setUTCDate(at.getUTCDate() - 1);
  return at;
}

// Moves a timestamp forward, keeping it inside waking hours. A reply that would
// land at 02:00 is a reply that really came the next morning, and rolling it
// there beats either a 3am timestamp or a gap that pretends to be instant.
function advance(from, minutes) {
  const at = new Date(from.getTime() + minutes * 60_000);
  const hour = at.getUTCHours();
  if (hour >= DAY_END || hour < DAY_START) {
    if (hour >= DAY_END) at.setUTCDate(at.getUTCDate() + 1);
    at.setUTCHours(rng.int(DAY_START, DAY_START + 3), rng.int(0, 59), 0, 0);
  }
  return at;
}

function buildThread({ user, template, sender, labelIds }) {
  const threadId = new mongoose.Types.ObjectId();
  const me = { name: user.name, address: user.email };
  const openedAt = randomSentAt();

  const bodies = [template.body, ...(template.replies ?? [])];

  // Gaps accumulate. Multiplying the index by a fresh random gap, which is the
  // obvious way to write this, lets message three land before message two and
  // leaves lastMessageAt pointing at the wrong one.
  let running = openedAt;
  const messages = bodies.map((body, i) => {
    const fromSender = i % 2 === 0;
    if (i > 0) running = advance(running, rng.int(20, 900));
    const sentAt = new Date(running);
    const subject = i === 0 ? template.subject : `Re: ${template.subject}`;

    return {
      userId: user._id,
      threadId,
      from: fromSender ? sender : me,
      to: [fromSender ? me : sender],
      subject,
      bodyText: body,
      snippet: makeSnippet(body),
      // My own replies live in sent; everything inbound lands in the inbox.
      folder: fromSender ? 'inbox' : 'sent',
      // Anything I already replied to has obviously been read.
      isRead: !fromSender || i < bodies.length - 1 || rng.chance(0.55),
      isStarred: fromSender && rng.chance(0.06),
      sentAt,
      intent: {
        label: null,
        confidence: null,
        // Stage 6 compares its own output against template.intent. Storing it
        // as the ground truth rather than a prediction keeps that honest.
        source: 'default',
        classifiedAt: null,
      },
      // Only inbound mail is labelled. The bucket says what a message asks of
      // me, and my own replies ask nothing. For a thread with several inbound
      // messages this is the thread's overall bucket stamped on each of them,
      // which is approximate: stage 6.5 refines it into per-message labels
      // when the eval set is built.
      seedIntent: fromSender ? template.intent : null,
    };
  });

  // Day rolling can push a long thread that started this morning past now.
  // Slide the whole thread back in whole days: shifting by the raw overflow
  // would fix the date and break the time, dropping messages into the middle
  // of the night that advance() just worked to avoid.
  const overflow = messages.at(-1).sentAt.getTime() - NOW;
  if (overflow > 0) {
    const shift = Math.ceil(overflow / 86_400_000) * 86_400_000;
    for (const m of messages) m.sentAt = new Date(m.sentAt.getTime() - shift);
  }

  const last = messages.at(-1);
  const folders = [...new Set(messages.map((m) => m.folder))];

  const thread = {
    _id: threadId,
    userId: user._id,
    subject: template.subject,
    normalizedSubject: normalizeSubject(template.subject),
    participants: [sender, me],
    snippet: last.snippet,
    messageCount: messages.length,
    lastMessageAt: last.sentAt,
    folders,
    hasUnread: messages.some((m) => !m.isRead),
    isStarred: messages.some((m) => m.isStarred),
    labelIds,
  };

  return { thread, messages };
}

// Thread depth, roughly as a mailbox actually looks: most threads are a single
// notification, a quarter get a short exchange, a few run on. Without this the
// corpus averages one message per thread and the reading pane has nothing to
// show.
function fillerDepth() {
  const roll = rng.next();
  if (roll < 0.58) return 0;
  if (roll < 0.85) return rng.int(1, 2);
  return rng.int(3, 7);
}

function fillerTemplate() {
  const n = rng.int(2, 28);
  const depth = fillerDepth();
  return {
    subject: rng.pick(FILLER_SUBJECTS).replaceAll('{n}', String(n)),
    body: rng.pick(FILLER_BODIES),
    replies: Array.from({ length: depth }, () => rng.pick(FILLER_REPLIES)),
    // A lone notification is just to be read. Once there is an exchange,
    // whoever wrote last decides what the thread is waiting on: an inbound
    // message with no answer from me needs one, my own last word does not.
    intent: depth === 0 ? 'read_only' : depth % 2 === 0 ? 'needs_reply' : 'waiting_on_them',
  };
}

async function main() {
  await connectDb();

  if (opts.reset) {
    // Only this user's mail. A shared dev database should not lose everyone
    // else's rows because one seed run wanted a clean slate.
    const existing = await User.findOne({ email: opts.email.toLowerCase() });
    if (existing) {
      const filter = { userId: existing._id };
      const [m, t, l, r] = await Promise.all([
        Message.deleteMany(filter),
        Thread.deleteMany(filter),
        Label.deleteMany(filter),
        RefreshToken.deleteMany(filter),
        IntentLabel.deleteMany(filter),
      ]);
      await User.deleteOne({ _id: existing._id });
      logger.info(
        { messages: m.deletedCount, threads: t.deletedCount, labels: l.deletedCount, sessions: r.deletedCount },
        'cleared previous seed',
      );
    }
  }

  // Registered through the service rather than inserted, so the seeded account
  // hashes with the same argon2 parameters as a real signup and can log in
  // through the real endpoint.
  let user = await User.findOne({ email: opts.email.toLowerCase() });
  if (!user) {
    user = await register({ email: opts.email, password: opts.password, name: opts.name });
  }

  const labels = await Label.insertMany(LABELS.map((l) => ({ ...l, userId: user._id })));
  const labelByName = new Map(labels.map((l) => [l.name, l._id]));
  const labelForRole = {
    landlord: 'Wohnung',
    university: 'Uni',
    recruiter: 'Bewerbungen',
    bank: 'Rechnungen',
    insurance: 'Rechnungen',
  };

  const threads = [];
  const messages = [];

  for (let i = 0; i < threadCount; i += 1) {
    // Each written thread appears exactly once. Repeating them padded the
    // corpus with copies of the same conversation, and a search that finds
    // five copies of the deposit thread looks better than it is.
    const template = i < THREADS.length ? THREADS[i] : fillerTemplate();
    const sender = template.role
      ? rng.pick(SENDERS.filter((s) => s.role === template.role))
      : rng.pick(SENDERS);

    const labelName = labelForRole[sender.role];
    const labelIds = labelName && rng.chance(0.7) ? [labelByName.get(labelName)] : [];

    const built = buildThread({ user, template, sender, labelIds });
    threads.push(built.thread);
    messages.push(...built.messages);
  }

  // A few unsent drafts, so the drafts folder is not empty before 2.3 exists.
  const draftCount = Math.max(3, Math.round(threadCount * 0.01));
  for (let i = 0; i < draftCount; i += 1) {
    const sender = rng.pick(SENDERS);
    const threadId = new mongoose.Types.ObjectId();
    const body = 'Guten Tag,\n\nich wollte nachfragen, ob';
    const sentAt = randomSentAt();
    const replyTo = rng.pick(THREADS);
    const subject = `Re: ${replyTo.subject}`;
    threads.push({
      _id: threadId,
      userId: user._id,
      subject,
      normalizedSubject: normalizeSubject(replyTo.subject),
      participants: [sender, { name: user.name, address: user.email }],
      snippet: makeSnippet(body),
      messageCount: 1,
      lastMessageAt: sentAt,
      folders: ['drafts'],
      hasUnread: false,
      isStarred: false,
      labelIds: [],
    });
    messages.push({
      userId: user._id,
      threadId,
      from: { name: user.name, address: user.email },
      to: [sender],
      subject,
      bodyText: body,
      snippet: makeSnippet(body),
      folder: 'drafts',
      isRead: true,
      isDraft: true,
      sentAt,
    });
  }

  // seedIntent is ground truth for stage 6, not a message field. It is lifted
  // off here, before the insert, and written to its own collection against
  // the ids the insert hands back. Strict mode would otherwise drop it
  // silently and the labels would be gone.
  const truths = messages.map((m) => m.seedIntent ?? null);
  for (const m of messages) delete m.seedIntent;

  await Thread.insertMany(threads, { ordered: false });
  // Chunked because a single insertMany of tens of thousands of documents can
  // exceed the 16 MB command limit once bodies are attached.
  let labelled = 0;
  for (let i = 0; i < messages.length; i += 1000) {
    const inserted = await Message.insertMany(messages.slice(i, i + 1000), { ordered: false });
    const labels = inserted.flatMap((doc, j) => {
      const label = truths[i + j];
      return label ? [{ userId: user._id, messageId: doc._id, label, source: 'seed' }] : [];
    });
    if (labels.length > 0) await IntentLabel.insertMany(labels, { ordered: false });
    labelled += labels.length;
  }

  const folderCounts = await Message.aggregate([
    { $match: { userId: user._id } },
    { $group: { _id: '$folder', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);

  logger.info(
    {
      user: user.email,
      threads: threads.length,
      messages: messages.length,
      labels: labels.length,
      folders: Object.fromEntries(folderCounts.map((f) => [f._id, f.n])),
      unread: await Message.countDocuments({ userId: user._id, isRead: false }),
      intentLabels: labelled,
      seed: opts.seed,
    },
    'seeded',
  );

  await disconnectDb();
}

main().catch(async (err) => {
  logger.fatal({ err }, 'seed failed');
  await disconnectDb().catch(() => {});
  process.exit(1);
});
