import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn, threadSummaryProblems } from './helpers.js';
import { createApp } from '../src/app.js';
import { Thread, Message } from '../src/models/index.js';
import { refreshThread } from '../src/services/thread-summary.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

const anna = { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' };
const ben = { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' };

// A thread built from message specs, oldest first, with its summary computed
// by the same function the service uses.
async function makeThread(userId, specs) {
  const threadId = new mongoose.Types.ObjectId();
  const now = Date.now();
  const docs = specs.map((spec, i) => ({
    userId,
    threadId,
    from: { address: 'someone@example.com' },
    subject: 'Betreff',
    bodyText: spec.body ?? `message ${i}`,
    snippet: spec.body ?? `message ${i}`,
    folder: spec.folder ?? 'inbox',
    isRead: spec.isRead ?? false,
    isStarred: spec.isStarred ?? false,
    isDraft: spec.isDraft ?? false,
    trashedFrom: spec.trashedFrom ?? null,
    sentAt: new Date(now - (specs.length - i) * 60_000),
  }));
  await Thread.create({ _id: threadId, userId, subject: 'Betreff', lastMessageAt: new Date(now) });
  await Message.insertMany(docs);
  await refreshThread(threadId);
  return threadId;
}

const act = (who, ids, action) =>
  request(app).post('/api/threads/batch').set('Cookie', who.cookie).send({ ids: ids.map(String), action });

const messagesOf = (threadId) => Message.find({ threadId }).sort({ sentAt: 1 }).lean();
const listed = async (who, folder) =>
  (await request(app).get(`/api/threads?folder=${folder}`).set('Cookie', who.cookie)).body.threads.map((t) => t.id);

async function expectInSync(...threadIds) {
  for (const id of threadIds) expect(await threadSummaryProblems(id)).toEqual([]);
}

describe('POST /api/threads/batch', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/threads/batch').send({ ids: [new mongoose.Types.ObjectId()], action: 'archive' });
    expect(res.status).toBe(401);
  });

  describe('read state', () => {
    it('marks every message in a thread read', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{}, {}]);

      const res = await act(a, [id], 'markRead');
      expect(res.status).toBe(200);
      expect(res.body.threads[0].hasUnread).toBe(false);
      expect((await messagesOf(id)).map((m) => m.isRead)).toEqual([true, true]);
      await expectInSync(id);
    });

    it('marks only the newest real message unread, leaving older ones and drafts alone', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [
        { isRead: true },
        { isRead: true },
        { isDraft: true, isRead: true, folder: 'drafts' },
      ]);

      const res = await act(a, [id], 'markUnread');
      expect(res.body.threads[0].hasUnread).toBe(true);
      expect((await messagesOf(id)).map((m) => m.isRead)).toEqual([true, false, true]);
      await expectInSync(id);
    });
  });

  describe('stars', () => {
    it('stars the newest real message, and unstar clears every star in the thread', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ isStarred: true }, {}, { isDraft: true, folder: 'drafts' }]);

      await act(a, [id], 'star');
      expect((await messagesOf(id)).map((m) => m.isStarred)).toEqual([true, true, false]);

      const res = await act(a, [id], 'unstar');
      expect(res.body.threads[0].isStarred).toBe(false);
      expect((await messagesOf(id)).map((m) => m.isStarred)).toEqual([false, false, false]);
      await expectInSync(id);
    });

    it('stars the draft when a thread holds nothing but a draft', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ isDraft: true, folder: 'drafts', isRead: true }]);

      const res = await act(a, [id], 'star');
      expect(res.body.threads[0].isStarred).toBe(true);
      await expectInSync(id);
    });
  });

  describe('archive', () => {
    it('moves inbox mail to archive, leaves sent mail alone, and takes the thread out of the inbox', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'inbox' }, { folder: 'sent', isRead: true }, { folder: 'inbox' }]);

      const res = await act(a, [id], 'archive');
      expect([...res.body.threads[0].folders].sort()).toEqual(['archive', 'sent']);
      expect((await messagesOf(id)).map((m) => m.folder)).toEqual(['archive', 'sent', 'archive']);
      expect(await listed(a, 'inbox')).toEqual([]);
      expect(await listed(a, 'archive')).toEqual([String(id)]);
      expect(await listed(a, 'sent')).toEqual([String(id)]);
      await expectInSync(id);
    });

    it('moves archived mail back to the inbox without touching sent mail', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'archive' }, { folder: 'sent', isRead: true }]);

      await act(a, [id], 'moveToInbox');
      expect((await messagesOf(id)).map((m) => m.folder)).toEqual(['inbox', 'sent']);
      await expectInSync(id);
    });

    it('does not pull anything out of trash', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'trash', trashedFrom: 'inbox' }]);

      await act(a, [id], 'archive');
      expect((await messagesOf(id)).map((m) => m.folder)).toEqual(['trash']);
    });
  });

  describe('trash and restore', () => {
    it('puts every message back where it was, not all into the inbox', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [
        { folder: 'inbox' },
        { folder: 'sent', isRead: true },
        { folder: 'archive' },
      ]);

      const trashed = await act(a, [id], 'trash');
      expect(trashed.body.threads[0].folders).toEqual(['trash']);
      expect(await listed(a, 'trash')).toEqual([String(id)]);
      await expectInSync(id);

      await act(a, [id], 'restore');
      const restored = await messagesOf(id);
      expect(restored.map((m) => m.folder)).toEqual(['inbox', 'sent', 'archive']);
      expect(restored.map((m) => m.trashedFrom)).toEqual([null, null, null]);
      await expectInSync(id);
    });

    it('survives being trashed twice before a restore', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'sent', isRead: true }]);

      await act(a, [id], 'trash');
      await act(a, [id], 'trash');
      await act(a, [id], 'restore');
      expect((await messagesOf(id)).map((m) => m.folder)).toEqual(['sent']);
    });

    it('takes a half-written reply to trash with its thread, and restores it to drafts', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'inbox' }, { folder: 'drafts', isDraft: true, isRead: true }]);

      const res = await act(a, [id], 'trash');
      expect(res.body.threads[0].folders).toEqual(['trash']);
      expect(await listed(a, 'drafts')).toEqual([]);
      await expectInSync(id);

      await act(a, [id], 'restore');
      const draft = (await messagesOf(id)).find((m) => m.isDraft);
      expect(draft.folder).toBe('drafts');
      expect(await listed(a, 'drafts')).toEqual([String(id)]);
      await expectInSync(id);
    });

    it('is never a silent no-op on a conversation that is only a draft', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'drafts', isDraft: true, isRead: true }]);

      const res = await act(a, [id], 'trash');
      expect(res.body.threads[0].folders).toEqual(['trash']);
      expect(await listed(a, 'drafts')).toEqual([]);
      expect(await listed(a, 'trash')).toEqual([String(id)]);
    });

    it('restores a trashed message with no record of where it came from to the inbox', async () => {
      const a = await signIn(app, anna);
      const id = await makeThread(a.user._id, [{ folder: 'trash', trashedFrom: null }]);

      await act(a, [id], 'restore');
      expect((await messagesOf(id)).map((m) => m.folder)).toEqual(['inbox']);
    });
  });

  describe('selections', () => {
    it('acts on several threads at once and answers in the order they were asked for', async () => {
      const a = await signIn(app, anna);
      const first = await makeThread(a.user._id, [{}]);
      const second = await makeThread(a.user._id, [{}]);
      const third = await makeThread(a.user._id, [{}]);

      const res = await act(a, [third, first, second, first], 'archive');
      expect(res.status).toBe(200);
      expect(res.body.threads.map((t) => t.id)).toEqual([third, first, second].map(String));
      expect(await listed(a, 'inbox')).toEqual([]);
      await expectInSync(first, second, third);
    });

    it('handles a full page of 100 threads in one request', async () => {
      const a = await signIn(app, anna);
      const ids = [];
      for (let i = 0; i < 100; i += 1) ids.push(await makeThread(a.user._id, [{}, { folder: 'sent', isRead: true }]));

      const res = await act(a, ids, 'trash');
      expect(res.status).toBe(200);
      expect(res.body.threads).toHaveLength(100);
      expect(await Message.countDocuments({ userId: a.user._id, folder: { $ne: 'trash' } })).toBe(0);
    });

    it("ignores ids that are not the user's, and says nothing about them", async () => {
      const a = await signIn(app, anna);
      const b = await signIn(app, ben);
      const mine = await makeThread(a.user._id, [{}]);
      const theirs = await makeThread(b.user._id, [{}]);
      const madeUp = new mongoose.Types.ObjectId();

      const res = await act(a, [theirs, mine, madeUp], 'trash');
      expect(res.status).toBe(200);
      expect(res.body.threads.map((t) => t.id)).toEqual([String(mine)]);
      expect((await messagesOf(theirs)).map((m) => m.folder)).toEqual(['inbox']);

      const onlyForeign = await act(a, [theirs, madeUp], 'trash');
      expect(onlyForeign.status).toBe(200);
      expect(onlyForeign.body.threads).toEqual([]);
    });
  });

  it("leaves the other side of a conversation untouched", async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    await request(app).post('/api/messages').set('Cookie', a.cookie).send({ to: [ben.email], subject: 'Hallo' });
    const benThread = await Thread.findOne({ userId: b.user._id });
    const annaThread = await Thread.findOne({ userId: a.user._id }).lean();

    for (const action of ['markRead', 'star', 'archive', 'trash']) await act(b, [benThread._id], action);

    const annaAfter = await Thread.findById(annaThread._id).lean();
    expect(annaAfter).toMatchObject({ folders: ['sent'], isStarred: false, hasUnread: false });
    const annaCopy = await Message.findOne({ userId: a.user._id }).lean();
    expect(annaCopy).toMatchObject({ folder: 'sent', isStarred: false, trashedFrom: null });
  });

  it.each([
    ['an unknown action', { ids: ['0123456789abcdef01234567'], action: 'explode' }, 'action'],
    ['no ids', { ids: [], action: 'archive' }, 'ids'],
    ['more than a page of ids', { ids: Array.from({ length: 101 }, () => '0123456789abcdef01234567'), action: 'archive' }, 'ids'],
    ['a malformed id', { ids: ['nope'], action: 'archive' }, 'ids.0'],
  ])('rejects %s', async (_label, body, field) => {
    const a = await signIn(app, anna);
    const res = await request(app).post('/api/threads/batch').set('Cookie', a.cookie).send(body);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });

  it('rejects unknown fields', async () => {
    const a = await signIn(app, anna);
    const res = await request(app)
      .post('/api/threads/batch')
      .set('Cookie', a.cookie)
      .send({ ids: ['0123456789abcdef01234567'], action: 'archive', everyone: true });
    expect(res.status).toBe(400);
  });
});
