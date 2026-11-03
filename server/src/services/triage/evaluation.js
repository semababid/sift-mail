import crypto from 'node:crypto';
import { IntentLabel, Message, User } from '../../models/index.js';
import { INTENTS, TRIAGE_FOLDERS } from '../../lib/constants.js';
import { embedMessages } from '../embedding/embed-messages.js';
import { nearestCorrections } from './corrections.js';

// How well triage sorts mail, measured against buckets given by hand (stage
// 6.5): zero-shot, and again after the user has corrected some of its
// mistakes. scripts/triage-label.js collects the labels and
// scripts/triage-eval.js runs this and prints the table.

// How many messages are labelled by hand.
export const EVAL_SIZE = 200;
// At most this many from one real sender. A mailbox has a few senders that
// send most of its mail, and without a cap Instagram would be a fifth of the
// set and the score would mostly say how well notifications are sorted.
export const PER_SENDER = 4;
// Two messages this alike count as the same message. The seeder writes some
// of its mail from templates, and copies would let one easy message be scored
// five times.
export const SAME_TEXT = 0.95;

// A fixed order for messages that looks random, so picking the set and
// stopping halfway gives the same messages next time. Mail that arrives later
// takes its own place in the order without moving anyone else's.
export const shuffleKey = (id) => crypto.createHash('sha256').update(`triage-eval:${id}`).digest('hex');

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
};

// The kind of mail a message counts as when picking: its seeded bucket, or
// "real" for imported mail, which has none. The set takes from each kind in turn so
// the buckets the seeder wrote few of still get what there is.
const stratumOf = (m) => (m.real ? 'real' : (m.seedLabel ?? 'unknown'));

// The messages to label, in the order to label them: the ones labelled or
// skipped already first, then new ones until there are `size` labelled.
// `candidates` are received messages as
// { _id, threadId, from, real, seedLabel, vector }; `done` maps the id of each
// message labelled or skipped to whether it was skipped.
//
// A message joins the set only if it is from a conversation not in the set
// yet, is less alike than SAME_TEXT to every message in it, and, for real
// mail, is from a sender with fewer than PER_SENDER messages in it.
export function pickEvalSet(candidates, { done = new Map(), size = EVAL_SIZE, perSender = PER_SENDER } = {}) {
  const ordered = [...candidates].sort((a, b) => (shuffleKey(a._id) < shuffleKey(b._id) ? -1 : 1));
  const chosen = [];
  const threads = new Set();
  const senders = new Map();
  const take = (m) => {
    chosen.push(m);
    threads.add(String(m.threadId));
    if (m.real) {
      const sender = m.from.address.toLowerCase();
      senders.set(sender, (senders.get(sender) ?? 0) + 1);
    }
  };
  const fits = (m) =>
    !threads.has(String(m.threadId)) &&
    !(m.real && (senders.get(m.from.address.toLowerCase()) ?? 0) >= perSender) &&
    !(m.vector && chosen.some((c) => c.vector && dot(c.vector, m.vector) >= SAME_TEXT));

  // What was labelled before stays in the set whatever the rules now say,
  // since the labels are the work.
  for (const m of ordered) if (done.has(String(m._id))) take(m);
  let labelled = [...done.values()].filter((skipped) => !skipped).length;

  const strata = new Map();
  for (const m of ordered) {
    if (done.has(String(m._id))) continue;
    if (!strata.has(stratumOf(m))) strata.set(stratumOf(m), []);
    strata.get(stratumOf(m)).push(m);
  }
  // In turn from each kind, the next message there that fits, until the set
  // is full or nothing fits anywhere.
  const queues = [...strata.values()];
  while (labelled < size && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      if (labelled >= size) break;
      while (queue.length > 0) {
        const m = queue.shift();
        if (fits(m)) {
          take(m);
          labelled += 1;
          break;
        }
      }
    }
  }
  return chosen;
}

// The corrections a user who had made `n` would have: the first n mistakes
// zero-shot made among `pool`, in the order they come across them, each with
// the bucket they gave it by hand.
export function correctionsFrom(pool, zeroShot, n) {
  const mistakes = pool.filter((item) => zeroShot.get(String(item._id)) !== item.truth);
  return mistakes.slice(0, n).map((item) => ({
    messageId: item._id,
    threadId: item.threadId,
    label: item.truth,
    vector: item.vector,
    from: item.message.from,
    bulk: item.message.bulk,
  }));
}

// Scores triage on `items`, labelled messages as
// { _id, threadId, truth, vector, message }, with `classify(item, examples)`
// answering a bucket, or null where the model gave none. Zero-shot first, then
// with `steps` corrections each.
//
// Leave one out: each message is sorted with the corrections the user would
// have made among all the other messages, never one about itself. They are the
// first mistakes in a fixed order, so most messages see the same corrections.
// A message no correction is near enough to gets no examples, and would be
// asked exactly what it was asked zero-shot, so it keeps that answer instead
// of being asked again.
//
// Answers { zeroShot, steps: [{ n, corrections, predicted, withExamples }] },
// `predicted` mapping each id to the bucket given. `corrections` is how many
// there were, which is fewer than n when zero-shot made fewer mistakes.
export async function evaluate(items, { classify, steps = [10, 25, 50], onProgress = () => {} }) {
  const ordered = [...items].sort((a, b) => (shuffleKey(a._id) < shuffleKey(b._id) ? -1 : 1));
  const id = (item) => String(item._id);
  const byId = new Map(ordered.map((item) => [id(item), item]));

  const zeroShot = new Map();
  for (const item of ordered) {
    zeroShot.set(id(item), await classify(item, []));
    onProgress({ step: 0, done: zeroShot.size, total: ordered.length });
  }

  // The same examples get the same answer at temperature 0, so each pair of
  // message and examples is asked once across all the steps.
  const asked = new Map();
  const results = [];
  for (const n of steps) {
    const predicted = new Map();
    let withExamples = 0;
    let corrections = 0;
    let done = 0;
    for (const item of ordered) {
      const others = ordered.filter((other) => other !== item);
      const made = correctionsFrom(others, zeroShot, n);
      corrections = Math.max(corrections, made.length);
      const nearest = nearestCorrections({ ...item.message, _id: item._id, threadId: item.threadId, vector: item.vector }, made);
      if (nearest.length === 0) {
        predicted.set(id(item), zeroShot.get(id(item)));
      } else {
        withExamples += 1;
        const key = `${id(item)}:${nearest.map((c) => String(c.messageId)).join(',')}`;
        if (!asked.has(key)) {
          const examples = nearest.map((c) => ({ message: byId.get(String(c.messageId)).message, label: c.label }));
          asked.set(key, await classify(item, examples));
        }
        predicted.set(id(item), asked.get(key));
      }
      done += 1;
      onProgress({ step: n, done, total: ordered.length });
    }
    results.push({ n, corrections, predicted, withExamples });
  }
  return { zeroShot, steps: results };
}

// Accuracy for each bucket, as the share of the messages labelled with it by
// hand that were sorted into it, and over all of them. { bucket: { right, of } }
// with `all` for the total.
export function accuracy(items, predicted) {
  const table = Object.fromEntries([...INTENTS, 'all'].map((bucket) => [bucket, { right: 0, of: 0 }]));
  for (const item of items) {
    const right = predicted.get(String(item._id)) === item.truth ? 1 : 0;
    for (const bucket of [item.truth, 'all']) {
      table[bucket].of += 1;
      table[bucket].right += right;
    }
  }
  return table;
}

// How often each bucket given by hand was sorted into each bucket:
// confusion[truth][predicted], with "none" for no answer.
export function confusion(items, predicted) {
  const table = Object.fromEntries(INTENTS.map((t) => [t, Object.fromEntries([...INTENTS, 'none'].map((p) => [p, 0]))]));
  for (const item of items) table[item.truth][predicted.get(String(item._id)) ?? 'none'] += 1;
  return table;
}

// What a message is shown and sorted from.
const MESSAGE_FIELDS = 'threadId from to cc subject bodyText bulk listName imap embeddingModel +embedding';

// Every received message of `userId` that could be labelled, as pickEvalSet
// takes them, each with its message. Ones without a vector from `ai` are given
// one first, since picking compares them.
//
// Mail the user sent themselves is left out, from their Sift address or from
// the account it was imported from. It is how Sift gets tested, and says
// nothing about the mail anyone else sends.
export async function loadCandidates(userId, { ai }) {
  // Not "complete": mail stored before bodies came in a second pass has no
  // bodyStatus at all.
  const received = { userId, folder: { $in: TRIAGE_FOLDERS }, isDraft: false, bodyStatus: { $ne: 'pending' } };
  const unembedded = await Message.find({ ...received, embeddingModel: { $ne: ai.embeddingModel } }).distinct('_id');
  if (unembedded.length > 0) await embedMessages(unembedded, { ai });

  const [messages, seeded, user] = await Promise.all([
    Message.find(received).select(MESSAGE_FIELDS).lean(),
    IntentLabel.find({ userId, source: 'seed' }).select('messageId label').lean(),
    User.findById(userId).select('email').lean(),
  ]);
  const seedOf = new Map(seeded.map((l) => [String(l.messageId), l.label]));
  const fromSelf = (m) => {
    const sender = m.from.address.toLowerCase();
    return sender === user?.email.toLowerCase() || sender === m.imap?.account?.toLowerCase();
  };
  return messages.filter((message) => !fromSelf(message)).map((message) => ({
    _id: message._id,
    threadId: message.threadId,
    from: message.from,
    real: message.imap != null,
    seedLabel: seedOf.get(String(message._id)) ?? null,
    vector: message.embedding,
    message,
  }));
}

// The eval labels of `userId`, skipped ones included: messageId to
// { label, skipped }.
export async function loadEvalLabels(userId) {
  const labels = await IntentLabel.find({ userId, source: 'eval' }).select('messageId label skipped').lean();
  return new Map(labels.map((l) => [String(l.messageId), { label: l.label ?? null, skipped: l.skipped === true }]));
}

// Stores a label given by hand, or that the message was skipped when `label`
// is null, in place of what was given for it before.
export async function saveEvalLabel(userId, messageId, label) {
  await IntentLabel.deleteOne({ messageId, source: 'eval' });
  await IntentLabel.create(
    label ? { userId, messageId, label, source: 'eval' } : { userId, messageId, source: 'eval', skipped: true },
  );
}

export const removeEvalLabel = (messageId) => IntentLabel.deleteOne({ messageId, source: 'eval' });

// The labelled messages of `userId`, as evaluate takes them.
export async function loadEvalItems(userId, { ai }) {
  const labels = await loadEvalLabels(userId);
  const ids = [...labels].filter(([, l]) => !l.skipped).map(([messageId]) => messageId);
  const unembedded = await Message.find({ _id: { $in: ids }, embeddingModel: { $ne: ai.embeddingModel } }).distinct('_id');
  if (unembedded.length > 0) await embedMessages(unembedded, { ai });
  const messages = await Message.find({ _id: { $in: ids }, userId }).select(MESSAGE_FIELDS).lean();
  return messages.map((message) => ({
    _id: message._id,
    threadId: message.threadId,
    truth: labels.get(String(message._id)).label,
    vector: message.embedding,
    real: message.imap != null,
    message,
  }));
}
