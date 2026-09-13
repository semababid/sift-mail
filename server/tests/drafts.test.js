import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn, threadSummaryProblems } from './helpers.js';
import { createApp } from '../src/app.js';
import { Thread, Message } from '../src/models/index.js';
import * as mail from '../src/services/mail.service.js';
import { refreshThread } from '../src/services/thread-summary.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);
afterEach(() => vi.restoreAllMocks());

const anna = { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' };
const ben = { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' };

const api = (who) => ({
  create: (body) => request(app).post('/api/drafts').set('Cookie', who.cookie).send(body),
  update: (id, body) => request(app).patch(`/api/drafts/${id}`).set('Cookie', who.cookie).send(body),
  remove: (id) => request(app).delete(`/api/drafts/${id}`).set('Cookie', who.cookie),
  send: (id) => request(app).post(`/api/drafts/${id}/send`).set('Cookie', who.cookie),
  message: (body) => request(app).post('/api/messages').set('Cookie', who.cookie).send(body),
});

async function pair() {
  const a = await signIn(app, anna);
  const b = await signIn(app, ben);
  return { a, b, annaApi: api(a), benApi: api(b) };
}

const inSync = async (threadId) => expect(await threadSummaryProblems(threadId)).toEqual([]);

describe('drafts', () => {
  it('saves an empty draft in a thread of its own, filed under drafts', async () => {
    const { a, annaApi } = await pair();
    const res = await annaApi.create({});
    expect(res.status).toBe(201);
    expect(res.body.draft.isDraft).toBe(true);

    const thread = await Thread.findById(res.body.draft.threadId).lean();
    expect(thread.folders).toEqual(['drafts']);
    await inSync(thread._id);

    const listed = await request(app).get('/api/threads?folder=drafts').set('Cookie', a.cookie);
    expect(listed.body.threads.map((t) => t.id)).toEqual([String(thread._id)]);
  });

  it('autosave updates the draft and the preview of its thread', async () => {
    const { annaApi } = await pair();
    const created = await annaApi.create({ subject: 'Ent' });
    const savedAt = Date.parse(created.body.draft.sentAt);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await annaApi.update(created.body.draft.id, { subject: 'Entwurf', bodyText: 'Hallo Ben' });
    expect(res.status).toBe(200);
    expect(Date.parse(res.body.draft.sentAt)).toBeGreaterThan(savedAt);

    const thread = await Thread.findById(created.body.draft.threadId).lean();
    expect(thread).toMatchObject({ subject: 'Entwurf', snippet: 'Hallo Ben' });
    await inSync(thread._id);
  });

  it('files a thread under drafts when a reply is started, without bumping or re-previewing it', async () => {
    const { b, annaApi, benApi } = await pair();
    await annaApi.message({ to: [ben.email], subject: 'Frage', bodyText: 'Hast du Zeit?' });
    const benThread = await Thread.findOne({ userId: b.user._id }).lean();

    const draft = await benApi.create({ threadId: String(benThread._id), bodyText: 'Ich schreibe gleich' });
    expect(draft.body.draft.subject).toBe('Re: Frage');

    const after = await Thread.findById(benThread._id).lean();
    expect([...after.folders].sort()).toEqual(['drafts', 'inbox']);
    expect(+after.lastMessageAt).toBe(+benThread.lastMessageAt);
    expect(after.snippet).toBe('Hast du Zeit?');
    expect(after.messageCount).toBe(1);
    await inSync(benThread._id);

    await benApi.remove(draft.body.draft.id);
    const discarded = await Thread.findById(benThread._id).lean();
    expect(discarded.folders).toEqual(['inbox']);
    await inSync(benThread._id);
  });

  it('removes the thread along with a standalone draft', async () => {
    const { annaApi } = await pair();
    const created = await annaApi.create({ subject: 'weg damit' });

    expect((await annaApi.remove(created.body.draft.id)).status).toBe(204);
    expect(await Thread.findById(created.body.draft.threadId)).toBeNull();
  });

  it.each([
    ['refuses unknown fields such as bodyHtml', { bodyHtml: '<b>x</b>' }],
    ['refuses an update with nothing in it', {}],
    ['refuses moving a draft to another thread', { threadId: '0123456789abcdef01234567' }],
  ])('%s', async (_label, body) => {
    const { annaApi } = await pair();
    const created = await annaApi.create({});
    expect((await annaApi.update(created.body.draft.id, body)).status).toBe(400);
  });

  it("will not start a reply draft in someone else's thread", async () => {
    const { a, benApi } = await pair();
    const annaDraft = await api(a).create({ subject: 'meins' });
    const res = await benApi.create({ threadId: annaDraft.body.draft.threadId });
    expect(res.status).toBe(404);
  });

  it("answers someone else's draft, and a message that is not a draft, with 404", async () => {
    const { annaApi, benApi } = await pair();
    const annaDraft = await annaApi.create({ subject: 'meins' });
    const sent = await annaApi.message({ to: [ben.email], subject: 'schon weg' });

    for (const id of [annaDraft.body.draft.id]) {
      expect((await benApi.update(id, { subject: 'x' })).status).toBe(404);
      expect((await benApi.remove(id)).status).toBe(404);
      expect((await benApi.send(id)).status).toBe(404);
    }
    for (const id of [sent.body.message.id]) {
      expect((await annaApi.update(id, { subject: 'x' })).status).toBe(404);
      expect((await annaApi.remove(id)).status).toBe(404);
      expect((await annaApi.send(id)).status).toBe(404);
    }
  });
});

describe('thread subject bookkeeping', () => {
  it('keeps the normalised subject in step when a draft subject is edited', async () => {
    const { annaApi } = await pair();
    const created = await annaApi.create({});
    await annaApi.update(created.body.draft.id, { subject: 'Re: Aw:  Wohnung  Besichtigung ', to: [ben.email] });

    const thread = await Thread.findById(created.body.draft.threadId).lean();
    expect(thread.subject).toBe('Re: Aw:  Wohnung  Besichtigung');
    expect(thread.normalizedSubject).toBe('wohnung besichtigung');
  });

  it('fills in a participant name once a later message supplies it', async () => {
    // Written through the model rather than the API: sending looks names up
    // from accounts, so over the API a Sift user is never nameless. Mail from
    // outside can be, and stage 4 brings that in.
    const { a } = await pair();
    const threadId = new mongoose.Types.ObjectId();
    await Thread.create({ _id: threadId, userId: a.user._id, lastMessageAt: new Date() });
    const base = { userId: a.user._id, threadId, folder: 'inbox', to: [{ address: anna.email }] };
    await Message.create({ ...base, from: { address: 'w.brandt@hausverwaltung.example' }, sentAt: new Date(1) });
    await Message.create({
      ...base,
      from: { name: 'Wolfgang Brandt', address: 'w.brandt@hausverwaltung.example' },
      sentAt: new Date(2),
    });

    const thread = await refreshThread(threadId);
    const landlord = thread.participants.find((p) => p.address === 'w.brandt@hausverwaltung.example');
    expect(landlord.name).toBe('Wolfgang Brandt');
  });

  it('gives a reply to mail with no subject no subject, rather than a bare "Re: "', async () => {
    const { b, annaApi, benApi } = await pair();
    await annaApi.message({ to: [ben.email] });
    const benThread = await Thread.findOne({ userId: b.user._id }).lean();

    const draft = await benApi.create({ threadId: String(benThread._id) });
    expect(draft.body.draft.subject).toBe('');
  });

  it('sends a draft from a trashed conversation as ordinary sent mail', async () => {
    const { annaApi, a } = await pair();
    const created = await annaApi.create({ to: [ben.email], bodyText: 'aus dem Papierkorb' });
    await request(app)
      .post('/api/threads/batch')
      .set('Cookie', a.cookie)
      .send({ ids: [created.body.draft.threadId], action: 'trash' });

    const sent = await annaApi.send(created.body.draft.id);
    expect(sent.status).toBe(201);
    const message = await Message.findById(created.body.draft.id).lean();
    expect(message).toMatchObject({ folder: 'sent', trashedFrom: null, isDraft: false });
  });
});

describe('sending a draft', () => {
  it('will not send a draft with no recipients, and leaves it editable', async () => {
    const { annaApi } = await pair();
    const created = await annaApi.create({ subject: 'an wen?' });

    const res = await annaApi.send(created.body.draft.id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_recipients');
    expect((await Message.findById(created.body.draft.id)).isDraft).toBe(true);
  });

  it('answers with the thread as it is stored after delivery when a draft is sent to yourself', async () => {
    const { annaApi } = await pair();
    const created = await annaApi.create({ to: [anna.email], subject: 'An mich', bodyText: 'Erinnerung' });

    const res = await annaApi.send(created.body.draft.id);
    const stored = await Thread.findById(res.body.thread.id).lean();
    expect([...res.body.thread.folders].sort()).toEqual(['inbox', 'sent']);
    expect(res.body.thread).toMatchObject({
      messageCount: stored.messageCount,
      hasUnread: stored.hasUnread,
      snippet: stored.snippet,
    });
    expect(res.body.thread.hasUnread).toBe(true);
  });

  it('turns the draft into the sent copy and delivers it', async () => {
    const { a, b, annaApi } = await pair();
    const created = await annaApi.create({ to: [ben.email], subject: 'Einladung', bodyText: 'Freitag?' });

    const res = await annaApi.send(created.body.draft.id);
    expect(res.status).toBe(201);
    expect(res.body.message.id).toBe(created.body.draft.id);
    expect(res.body.message).toMatchObject({ folder: 'sent', isDraft: false });

    const drafts = await request(app).get('/api/threads?folder=drafts').set('Cookie', a.cookie);
    expect(drafts.body.threads).toEqual([]);

    const received = await Message.find({ userId: b.user._id, folder: 'inbox' }).lean();
    expect(received.map((m) => m.bodyText)).toEqual(['Freitag?']);
    await inSync(created.body.draft.threadId);
    await inSync(received[0].threadId);
  });

  it('delivers once when the same draft is sent twice at the same moment', async () => {
    const { b, annaApi } = await pair();
    const created = await annaApi.create({ to: [ben.email], subject: 'nur einmal' });

    const [first, second] = await Promise.all([
      annaApi.send(created.body.draft.id),
      annaApi.send(created.body.draft.id),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 404]);
    expect(await Message.countDocuments({ userId: b.user._id, folder: 'inbox' })).toBe(1);
  });

  it('ignores an autosave that arrives after the draft was sent', async () => {
    const { annaApi } = await pair();
    const created = await annaApi.create({ to: [ben.email], bodyText: 'final' });
    await annaApi.send(created.body.draft.id);

    const late = await annaApi.update(created.body.draft.id, { bodyText: 'changed my mind' });
    expect(late.status).toBe(404);
    expect((await Message.findById(created.body.draft.id)).bodyText).toBe('final');
  });

  it('refuses an autosave that loses a race with the send', async () => {
    const { a, annaApi } = await pair();
    const created = await annaApi.create({ to: [ben.email], bodyText: 'final' });
    const id = created.body.draft.id;

    // Lands the send in the gap between updateDraft reading the draft and
    // writing it back. The test above only covers an autosave that arrives
    // after the send has finished, which the first read already turns away.
    const realWrite = Message.findOneAndUpdate.bind(Message);
    vi.spyOn(Message, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      await Message.updateOne({ _id: id }, { $set: { isDraft: false, folder: 'sent' } });
      return realWrite(...args);
    });

    await expect(mail.updateDraft(a.user, id, { bodyText: 'changed my mind' })).rejects.toMatchObject({
      status: 404,
    });
    expect((await Message.findById(id)).bodyText).toBe('final');
  });

  it("does not name a draft's own Message-ID as the message it answers", async () => {
    const { b, annaApi, benApi } = await pair();
    await annaApi.message({ to: [ben.email], subject: 'Frage' });
    const original = await Message.findOne({ userId: b.user._id, folder: 'inbox' }).lean();

    const draft = await benApi.create({ threadId: String(original.threadId), to: [anna.email], bodyText: 'Antwort' });
    // Drafts synced from a real mailbox in stage 4 arrive with a Message-ID of
    // their own. Nothing in Sift assigns one yet, so it is set by hand here.
    await Message.updateOne({ _id: draft.body.draft.id }, { rfcMessageId: '<draft-from-imap@example.com>' });

    const sent = await benApi.send(draft.body.draft.id);
    expect(sent.status).toBe(201);
    expect(sent.body.message.inReplyTo).toBe(original.rfcMessageId);
    expect(sent.body.message.references).toEqual([original.rfcMessageId]);
  });

  it('threads a sent reply draft exactly like a direct reply', async () => {
    const { a, b, annaApi, benApi } = await pair();
    const first = await annaApi.message({ to: [ben.email], subject: 'Termin', bodyText: 'Montag?' });
    const benThread = await Thread.findOne({ userId: b.user._id }).lean();

    const draft = await benApi.create({ threadId: String(benThread._id), to: [anna.email], bodyText: 'Passt.' });
    expect((await benApi.send(draft.body.draft.id)).status).toBe(201);

    expect(await Thread.countDocuments({ userId: a.user._id })).toBe(1);
    const annaThread = await Thread.findById(first.body.thread.id).lean();
    expect(annaThread.messageCount).toBe(2);
    await inSync(annaThread._id);
    await inSync(benThread._id);
  });
});
