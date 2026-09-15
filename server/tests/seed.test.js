import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, credentials } from './helpers.js';
import { createApp } from '../src/app.js';
import { User, Thread, Message, IntentLabel } from '../src/models/index.js';
import { THREADS as WRITTEN, SENDERS, NOTIFICATIONS, CONVERSATIONS } from '../scripts/seed-data.js';

const serverDir = path.resolve(import.meta.dirname, '..');

// A morning, in UTC. Seeding while most of the day is still ahead is what
// exposes timestamps landing after "now". Run the same seed at 21:00 and there
// is no later today left to land in, so the bug hides.
const NOW = '2026-03-10T07:30:00Z';
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;

// Seed 4 at 1200 threads is a known bad case: before drafts were clamped to
// the past, it dated two of them later the same day. Most seeds happen to
// avoid it, which is how the bug got past a hand check on seed 42.
const SEED = '4';
const THREADS = 1200;

function seed(...extra) {
  const run = spawnSync(
    process.execPath,
    ['scripts/seed.js', '--reset', '--threads', String(THREADS), '--seed', SEED, '--now', NOW, ...extra],
    { cwd: serverDir, env: process.env, encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`seed failed:\n${run.stderr}`);
}

async function loadCorpus() {
  const user = await User.findOne({ email: credentials.email });
  const threads = await Thread.find({ userId: user._id }).lean();
  // _id order is construction order, since ids are assigned client side before
  // the insert. That is the order a thread's messages were written in.
  const messages = await Message.find({ userId: user._id }).sort({ _id: 1 }).lean();
  const byThread = Map.groupBy(messages, (m) => String(m.threadId));
  return { user, threads, messages, byThread };
}

// Order-independent, so two identical corpora match however Mongo returns them.
async function fingerprint() {
  const { messages } = await loadCorpus();
  const lines = messages
    .map((m) => `${m.sentAt.toISOString()}|${m.subject}|${m.folder}|${m.from.address}|${m.snippet}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

let corpus;

beforeAll(async () => {
  await connect();
  seed();
  corpus = await loadCorpus();
});

afterAll(disconnect);

describe('seeded corpus', () => {
  it('creates the requested threads plus a few drafts', () => {
    expect(corpus.threads.length).toBeGreaterThanOrEqual(THREADS);
    expect(corpus.threads.length).toBeLessThanOrEqual(THREADS + Math.max(3, THREADS * 0.01));
  });

  it('persists no seed-only fields', async () => {
    // Straight to the driver. strictQuery rewrites a filter on a path the
    // schema does not know into {}, so asking Mongoose would count everything.
    const raw = mongoose.connection.db.collection('messages');
    expect(await raw.countDocuments({ seedIntent: { $exists: true } })).toBe(0);
  });

  it("keeps every thread's summary in step with its messages", () => {
    const wrong = [];
    for (const thread of corpus.threads) {
      const messages = corpus.byThread.get(String(thread._id));
      const newest = messages.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));
      const folders = [...new Set(messages.map((m) => m.folder))].sort();

      if (thread.messageCount !== messages.length) wrong.push(`${thread._id} messageCount`);
      if (+thread.lastMessageAt !== +newest.sentAt) wrong.push(`${thread._id} lastMessageAt`);
      if (thread.snippet !== newest.snippet) wrong.push(`${thread._id} snippet`);
      if ([...thread.folders].sort().join() !== folders.join()) wrong.push(`${thread._id} folders`);
      if (thread.hasUnread !== messages.some((m) => !m.isRead)) wrong.push(`${thread._id} hasUnread`);
      if (thread.isStarred !== messages.some((m) => m.isStarred)) wrong.push(`${thread._id} isStarred`);
    }
    expect(wrong).toEqual([]);
  });

  it('never dates a reply before the message it answers', () => {
    const disordered = [...corpus.byThread.entries()]
      .filter(([, messages]) => messages.some((m, i) => i > 0 && m.sentAt < messages[i - 1].sentAt))
      .map(([id]) => id);
    expect(disordered).toEqual([]);
  });

  it('dates nothing after the pinned clock', () => {
    const future = corpus.messages.filter((m) => +m.sentAt > NOW_MS).map((m) => m.sentAt.toISOString());
    expect(future).toEqual([]);
  });

  it('keeps every timestamp inside waking hours, in UTC', () => {
    const outside = corpus.messages
      .map((m) => m.sentAt.getUTCHours())
      .filter((hour) => hour < 6 || hour > 20);
    expect(outside).toEqual([]);
  });

  it('is mostly short threads with some that run on', () => {
    const depths = corpus.threads.map((t) => t.messageCount);
    const share = (test) => depths.filter(test).length / depths.length;

    expect(share((d) => d === 1)).toBeGreaterThan(0.4);
    expect(share((d) => d === 1)).toBeLessThan(0.8);
    expect(share((d) => d >= 4)).toBeGreaterThan(0.05);
  });

  it('is denser at the recent end, like a real mailbox', () => {
    const lastMonth = corpus.messages.filter((m) => +m.sentAt >= NOW_MS - 30 * DAY).length;
    const halfYearBack = corpus.messages.filter((m) => +m.sentAt < NOW_MS - 150 * DAY).length;
    expect(lastMonth).toBeGreaterThan(halfYearBack * 2);
  });

  it('plants the deposit thread where only its own wording can find it', async () => {
    // By exact subject. The seeded drafts are titled "Re: <subject>" of a
    // hand-written thread, so a pattern can pick up a draft instead.
    const needle = await Thread.findOne({ userId: corpus.user._id, subject: 'Wohnungsübergabe Parkstraße 14' });
    expect(needle).not.toBeNull();

    const threadsMatching = async (search) =>
      (await Message.find({ userId: corpus.user._id, $text: { $search: search } }).lean()).map((m) =>
        String(m.threadId),
      );

    // The German word it actually uses finds it, which proves it is indexed...
    expect(await threadsMatching('Kaution')).toContain(String(needle._id));
    // ...and the way someone would describe it in English does not.
    expect(await threadsMatching('flat deposit')).not.toContain(String(needle._id));
  });

  it('creates an account that logs in through the real endpoint', async () => {
    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect(res.status).toBe(200);
  });
});

describe('ground truth for stage 6', () => {
  it('labels every inbound message and nothing I wrote myself', async () => {
    const labelled = await IntentLabel.countDocuments({ userId: corpus.user._id, source: 'seed' });
    const inbound = corpus.messages.filter((m) => m.folder === 'inbox').length;
    expect(labelled).toBe(inbound);

    const mine = corpus.messages.filter((m) => m.folder !== 'inbox').map((m) => m._id);
    expect(mine.length).toBeGreaterThan(0);
    expect(await IntentLabel.countDocuments({ messageId: { $in: mine } })).toBe(0);
  });

  // Each subject template as a pattern, so a generated thread can be traced back
  // to the notification or conversation it came from.
  const patternFor = (subject) =>
    new RegExp(`^${subject.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+?')}$`);
  const originOf = (thread) =>
    NOTIFICATIONS.find((n) => patternFor(n.subject).test(thread.subject)) ??
    CONVERSATIONS.find((c) => patternFor(c.subject).test(thread.subject));
  const kindOf = new Map(SENDERS.map((sender) => [sender.address, sender.kind]));
  const labelsById = async () =>
    new Map((await IntentLabel.find({ userId: corpus.user._id }).lean()).map((l) => [String(l.messageId), l.label]));

  it('sends automated mail only from organisations, unanswered, with its own bucket', async () => {
    const labels = await labelsById();
    const automated = corpus.threads.filter((t) => NOTIFICATIONS.includes(originOf(t)));
    expect(automated.length).toBeGreaterThan(300);

    for (const thread of automated) {
      const messages = corpus.byThread.get(String(thread._id));
      expect(messages).toHaveLength(1);
      expect(kindOf.get(messages[0].from.address)).toBe('organisation');
      expect(labels.get(String(messages[0]._id))).toBe(originOf(thread).intent);
    }
  });

  it('holds conversations only with people', () => {
    const talks = corpus.threads.filter((t) => CONVERSATIONS.includes(originOf(t)));
    expect(talks.length).toBeGreaterThan(300);
    const kinds = new Set(talks.map((t) => kindOf.get(corpus.byThread.get(String(t._id))[0].from.address)));
    expect(kinds).toEqual(new Set(['person']));
  });

  it('never has me send back a line the other side wrote, or repeat a line within a thread', () => {
    const echoes = [];
    const repeats = [];
    for (const [id, messages] of corpus.byThread) {
      const theirs = new Set(messages.filter((m) => m.from.address !== credentials.email).map((m) => m.bodyText));
      if (messages.some((m) => m.from.address === credentials.email && theirs.has(m.bodyText))) echoes.push(id);
      const bodies = messages.map((m) => m.bodyText);
      if (new Set(bodies).size < bodies.length) repeats.push(id);
    }
    expect(echoes).toEqual([]);
    expect(repeats).toEqual([]);
  });

  // A script line as a pattern that captures the weekday its placeholder became.
  // Weekdays written literally into a line, like "Dienstag oder Mittwoch", are
  // ordinary text and are not captured.
  const weekdayIn = (template, text) => {
    if (!template.includes('{weekday}')) return undefined;
    const source = template
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace('{weekday}', '(?<weekday>\\w+)')
      .replaceAll('{weekday}', '\\k<weekday>')
      .replace(/\{\w+\}/g, '[\\s\\S]+?');
    return new RegExp(`^${source}$`).exec(text)?.groups?.weekday;
  };

  it('fills placeholders once per thread, so its weekday stays the same throughout', () => {
    let checked = 0;
    for (const thread of corpus.threads) {
      const origin = originOf(thread);
      if (!CONVERSATIONS.includes(origin)) continue;

      const mentions = [
        weekdayIn(origin.subject, thread.subject),
        ...corpus.byThread.get(String(thread._id)).map((m, i) => weekdayIn(origin.lines[i].text, m.bodyText)),
      ].filter(Boolean);
      // Only a thread that names its weekday at least twice can disagree with itself.
      if (mentions.length < 2) continue;

      expect([...new Set(mentions)], thread.subject).toHaveLength(1);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('labels each message in a conversation by what it asks at the moment it arrives', async () => {
    const labels = await labelsById();
    let checked = 0;
    for (const thread of corpus.threads) {
      const origin = originOf(thread);
      if (!CONVERSATIONS.includes(origin)) continue;
      corpus.byThread.get(String(thread._id)).forEach((message, i) => {
        // Their lines are the even ones. Mine are never labelled.
        if (i % 2 === 1) return;
        expect(labels.get(String(message._id))).toBe(origin.lines[i].intent);
        checked += 1;
      });
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('has plenty of examples in every triage bucket', async () => {
    const rows = await IntentLabel.aggregate([
      { $match: { userId: corpus.user._id } },
      { $group: { _id: '$label', n: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(rows.map((row) => [row._id, row.n]));
    for (const bucket of ['needs_reply', 'waiting_on_them', 'do_at_a_time', 'read_only']) {
      expect(counts[bucket] ?? 0, bucket).toBeGreaterThan(50);
    }
  });

  it('writes each hand-written conversation exactly once', async () => {
    const counts = WRITTEN.map((t) => corpus.threads.filter((c) => c.subject === t.subject).length);
    expect(counts).toEqual(WRITTEN.map(() => 1));
  });

  it('leaves no labels behind on --reset', async () => {
    // --reset recreates the account, so the user id changes. Counting across
    // all users is what shows whether labels from the old one were cleared.
    const before = await IntentLabel.countDocuments({});
    expect(before).toBeGreaterThan(0);
    seed();
    expect(await IntentLabel.countDocuments({})).toBe(before);
    corpus = await loadCorpus();
  });
});

describe('determinism', () => {
  it('rebuilds an identical corpus, timestamps included, from the same seed and clock', async () => {
    const first = await fingerprint();
    seed();
    expect(await fingerprint()).toBe(first);
  });

  it('builds a different corpus from a different seed', async () => {
    const first = await fingerprint();
    seed('--seed', '7');
    expect(await fingerprint()).not.toBe(first);
  });
});
