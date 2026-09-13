import mongoose from 'mongoose';
import request from 'supertest';
import { User, Thread, Message } from '../src/models/index.js';
import { refreshThread } from '../src/services/thread-summary.js';

export const credentials = { email: 'semab@sift.example', password: 'correct-horse', name: 'Semab' };

export async function connect() {
  const { connectDb } = await import('../src/config/db.js');
  await connectDb();
  // Indexes build in the background after connecting. A duplicate-email test
  // that runs before the unique index exists passes for the wrong reason.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function disconnect() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
}

// Empties every collection but keeps its indexes, which dropping would lose.
export async function clearDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

// Several tests replay an old cookie or fire two requests carrying the same
// one, which needs the cookies under the test's control rather than an agent's.
export function cookieJar() {
  const jar = new Map();

  return {
    capture(res) {
      for (const raw of res.headers['set-cookie'] ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i);
        const value = pair.slice(i + 1);
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (name) => jar.get(name),
    has: (name) => jar.has(name),
  };
}

// Registers an account through the real endpoint and returns its session
// cookie alongside the stored user.
export async function signIn(app, who = credentials) {
  const jar = cookieJar();
  jar.capture(await request(app).post('/api/auth/register').send(who));
  const user = await User.findOne({ email: who.email });
  return { cookie: jar.header(), user };
}

// Every way a thread's stored summary disagrees with the messages under it.
// Empty means in sync. Drafts follow the service's rule: they file a thread
// under drafts, but only decide the summary when nothing else is there.
export async function threadSummaryProblems(threadId) {
  const thread = await Thread.findById(threadId).lean();
  const messages = await Message.find({ threadId }).sort({ sentAt: 1, _id: 1 }).lean();

  if (!thread) return messages.length > 0 ? ['thread is gone but its messages remain'] : [];
  if (messages.length === 0) return ['thread has no messages left'];

  const real = messages.filter((m) => !m.isDraft);
  const basis = real.length > 0 ? real : messages;
  const last = basis.at(-1);

  const problems = [];
  const check = (field, stored, expected) => {
    if (stored !== expected) problems.push(`${field}: stored ${stored}, expected ${expected}`);
  };
  check('messageCount', thread.messageCount, basis.length);
  check('lastMessageAt', +thread.lastMessageAt, +last.sentAt);
  check('snippet', thread.snippet, last.snippet);
  check('folders', [...thread.folders].sort().join(), [...new Set(messages.map((m) => m.folder))].sort().join());
  check('hasUnread', thread.hasUnread, messages.some((m) => !m.isRead));
  check('isStarred', thread.isStarred, messages.some((m) => m.isStarred));
  return problems;
}

// A thread built from message specs, oldest first, with its summary computed by
// the same function the services use. A spec may pin its time with `at`.
export async function makeThread(userId, specs, { labelIds = [], subject = 'Betreff' } = {}) {
  const threadId = new mongoose.Types.ObjectId();
  const now = Date.now();

  await Thread.create({ _id: threadId, userId, subject, labelIds, lastMessageAt: new Date(now) });
  await Message.insertMany(
    specs.map((spec, i) => ({
      userId,
      threadId,
      from: { address: 'someone@example.com' },
      subject,
      bodyText: spec.body ?? `message ${i}`,
      snippet: spec.body ?? `message ${i}`,
      folder: spec.folder ?? 'inbox',
      isRead: spec.isRead ?? false,
      isStarred: spec.isStarred ?? false,
      isDraft: spec.isDraft ?? false,
      trashedFrom: spec.trashedFrom ?? null,
      sentAt: new Date(spec.at ?? now - (specs.length - i) * 60_000),
    })),
  );
  await refreshThread(threadId);
  return threadId;
}
