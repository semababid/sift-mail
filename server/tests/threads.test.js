import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, cookieJar, credentials } from './helpers.js';
import { createApp } from '../src/app.js';
import { Thread, Message, User } from '../src/models/index.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

async function signIn(who = credentials) {
  const jar = cookieJar();
  jar.capture(await request(app).post('/api/auth/register').send(who));
  const user = await User.findOne({ email: who.email });
  return { cookie: jar.header(), user };
}

// Builds a thread and its messages the way the seeder does: summary fields on
// the thread agree with the messages under it.
async function makeThread(userId, { at, folders = ['inbox'], messages = 1, subject = 'Hallo' } = {}) {
  const threadId = new mongoose.Types.ObjectId();
  const docs = Array.from({ length: messages }, (_, i) => ({
    userId,
    threadId,
    from: { address: 'someone@example.com' },
    subject,
    bodyText: `body ${i}`,
    snippet: `body ${i}`,
    folder: folders[i % folders.length],
    sentAt: new Date(at.getTime() - (messages - 1 - i) * 60_000),
  }));
  await Message.insertMany(docs);
  return Thread.create({
    _id: threadId,
    userId,
    subject,
    lastMessageAt: at,
    folders: [...new Set(docs.map((d) => d.folder))],
    messageCount: messages,
    snippet: docs.at(-1).snippet,
  });
}

const list = (cookie, query = {}) => request(app).get('/api/threads').query(query).set('Cookie', cookie);

async function walkAllPages(cookie, query) {
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const res = await list(cookie, { ...query, ...(cursor ? { cursor } : {}) });
    expect(res.status).toBe(200);
    seen.push(...res.body.threads);
    cursor = res.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 100);
  return { seen, pages };
}

describe('GET /api/threads', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/threads')).status).toBe(401);
  });

  it('lists the inbox newest first by default', async () => {
    const { cookie, user } = await signIn();
    const now = Date.now();
    await makeThread(user._id, { at: new Date(now - 3000), subject: 'old' });
    await makeThread(user._id, { at: new Date(now - 1000), subject: 'new' });
    await makeThread(user._id, { at: new Date(now - 2000), subject: 'middle' });

    const res = await list(cookie);
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t) => t.subject)).toEqual(['new', 'middle', 'old']);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.threads[0]).toHaveProperty('id');
  });

  it('pages through every thread exactly once, even when many share a timestamp', async () => {
    const { cookie, user } = await signIn();
    const shared = new Date('2026-03-01T10:00:00Z');
    // 25 threads with an identical lastMessageAt sitting across page borders,
    // between 20 with distinct ones. A cursor on the timestamp alone loses rows here.
    for (let i = 0; i < 10; i += 1) await makeThread(user._id, { at: new Date(shared.getTime() + (i + 1) * 1000) });
    for (let i = 0; i < 25; i += 1) await makeThread(user._id, { at: shared });
    for (let i = 0; i < 10; i += 1) await makeThread(user._id, { at: new Date(shared.getTime() - (i + 1) * 1000) });

    const { seen, pages } = await walkAllPages(cookie, { limit: 7 });
    const ids = seen.map((t) => t.id);

    expect(pages).toBe(Math.ceil(45 / 7));
    expect(ids).toHaveLength(45);
    expect(new Set(ids).size).toBe(45);

    const order = seen.map((t) => [Date.parse(t.lastMessageAt), t.id]);
    const sorted = [...order].sort((a, b) => b[0] - a[0] || (b[1] > a[1] ? 1 : -1));
    expect(order).toEqual(sorted);
  });

  it('says there is no next page when the last page is exactly full', async () => {
    const { cookie, user } = await signIn();
    for (let i = 0; i < 4; i += 1) await makeThread(user._id, { at: new Date(Date.now() - i * 1000) });

    const first = await list(cookie, { limit: 2 });
    const second = await list(cookie, { limit: 2, cursor: first.body.nextCursor });
    expect(second.body.threads).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
  });

  it('shows a thread in every folder its messages live in', async () => {
    const { cookie, user } = await signIn();
    await makeThread(user._id, { at: new Date(), folders: ['inbox', 'sent'], messages: 2, subject: 'both' });

    expect((await list(cookie, { folder: 'inbox' })).body.threads.map((t) => t.subject)).toEqual(['both']);
    expect((await list(cookie, { folder: 'sent' })).body.threads.map((t) => t.subject)).toEqual(['both']);
    expect((await list(cookie, { folder: 'trash' })).body.threads).toEqual([]);
  });

  it("never shows another user's threads", async () => {
    const me = await signIn();
    const other = await signIn({ ...credentials, email: 'other@sift.example' });
    await makeThread(other.user._id, { at: new Date(), subject: 'not yours' });
    await makeThread(me.user._id, { at: new Date(), subject: 'yours' });

    const res = await list(me.cookie);
    expect(res.body.threads.map((t) => t.subject)).toEqual(['yours']);
  });

  it("uses the user's page size when no limit is given", async () => {
    const { cookie, user } = await signIn();
    await User.updateOne({ _id: user._id }, { 'settings.messagesPerPage': 3 });
    for (let i = 0; i < 5; i += 1) await makeThread(user._id, { at: new Date(Date.now() - i * 1000) });

    const res = await list(cookie);
    expect(res.body.threads).toHaveLength(3);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it.each([
    [{ folder: 'nonsense' }, 'folder'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 101 }, 'limit'],
    [{ limit: 'lots' }, 'limit'],
  ])('rejects %o', async (query, field) => {
    const { cookie } = await signIn();
    const res = await list(cookie, query);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });

  it.each(['garbage', Buffer.from('{"t":"x","id":"1"}').toString('base64url'), Buffer.from('[]').toString('base64url')])(
    'rejects the malformed cursor %s',
    async (cursor) => {
      const { cookie } = await signIn();
      const res = await list(cookie, { cursor });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_cursor');
    },
  );
});

describe('GET /api/threads/:id', () => {
  it('returns the thread with its messages oldest first', async () => {
    const { cookie, user } = await signIn();
    const thread = await makeThread(user._id, { at: new Date(), messages: 3, folders: ['inbox', 'sent'] });

    const res = await request(app).get(`/api/threads/${thread._id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.thread.id).toBe(thread._id.toString());
    expect(res.body.messages.map((m) => m.bodyText)).toEqual(['body 0', 'body 1', 'body 2']);
    expect(res.body.messages[0]).not.toHaveProperty('embedding');
  });

  it('leaves unread state alone', async () => {
    const { cookie, user } = await signIn();
    const thread = await makeThread(user._id, { at: new Date() });

    await request(app).get(`/api/threads/${thread._id}`).set('Cookie', cookie);
    expect((await Thread.findById(thread._id)).hasUnread).toBe(true);
    expect(await Message.countDocuments({ threadId: thread._id, isRead: false })).toBe(1);
  });

  it.each([
    ["someone else's thread", async (other) => (await makeThread(other.user._id, { at: new Date() }))._id.toString()],
    ['a thread that does not exist', async () => new mongoose.Types.ObjectId().toString()],
    ['an id that is not an ObjectId', async () => 'not-an-id'],
  ])('answers %s with the same 404', async (_label, idFor) => {
    const me = await signIn();
    const other = await signIn({ ...credentials, email: 'other@sift.example' });
    const id = await idFor(other);

    const res = await request(app).get(`/api/threads/${id}`).set('Cookie', me.cookie);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});
