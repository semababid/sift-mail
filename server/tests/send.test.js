import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn, threadSummaryProblems } from './helpers.js';
import { createApp } from '../src/app.js';
import { Thread, Message } from '../src/models/index.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

const people = {
  anna: { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' },
  ben: { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' },
  cleo: { email: 'cleo@sift.example', password: 'correct-horse', name: 'Cleo' },
};

async function everyone() {
  const anna = await signIn(app, people.anna);
  const ben = await signIn(app, people.ben);
  const cleo = await signIn(app, people.cleo);
  return { anna, ben, cleo };
}

const send = (who, body) => request(app).post('/api/messages').set('Cookie', who.cookie).send(body);
const inboxOf = (who) => Message.find({ userId: who.user._id, folder: 'inbox' }).sort({ _id: 1 }).lean();
const sentOf = (who) => Message.find({ userId: who.user._id, folder: 'sent' }).sort({ _id: 1 }).lean();

async function expectInSync(...threadIds) {
  for (const id of threadIds) expect(await threadSummaryProblems(id)).toEqual([]);
}

describe('POST /api/messages', () => {
  it('requires a session', async () => {
    const res = await request(app).post('/api/messages').send({ to: [people.ben.email] });
    expect(res.status).toBe(401);
  });

  it("delivers to another user's inbox and files the sender's copy under sent", async () => {
    const { anna, ben } = await everyone();
    const res = await send(anna, { to: [people.ben.email], subject: 'Hallo', bodyText: 'Wie geht es?' });
    expect(res.status).toBe(201);

    const [sent] = await sentOf(anna);
    const [received] = await inboxOf(ben);

    expect(sent.isRead).toBe(true);
    expect(received.isRead).toBe(false);
    expect(received.bodyText).toBe('Wie geht es?');
    expect(received.from).toMatchObject({ name: 'Anna', address: people.anna.email });
    expect(received.to[0]).toMatchObject({ name: 'Ben', address: people.ben.email });
    expect(received.rfcMessageId).toMatch(/^<.+@sift\.local>$/);
    expect(received.rfcMessageId).toBe(sent.rfcMessageId);
    expect(String(received.threadId)).not.toBe(String(sent.threadId));
    await expectInSync(sent.threadId, received.threadId);
  });

  it("puts the conversation in the recipient's inbox list, unread", async () => {
    const { anna, ben } = await everyone();
    await send(anna, { to: [people.ben.email], subject: 'Hallo' });

    const res = await request(app).get('/api/threads').set('Cookie', ben.cookie);
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0]).toMatchObject({ subject: 'Hallo', hasUnread: true, messageCount: 1 });
  });

  it('answers identically whether or not a recipient has an account', async () => {
    const { anna } = await everyone();
    const toUser = await send(anna, { to: [people.ben.email], subject: 'x' });
    const toStranger = await send(anna, { to: ['nobody@elsewhere.example'], subject: 'x' });

    expect(toStranger.status).toBe(toUser.status);
    expect(Object.keys(toStranger.body).sort()).toEqual(['message', 'thread']);
    expect(Object.keys(toUser.body).sort()).toEqual(['message', 'thread']);

    // Kept on the sent copy. With an SMTP server configured it also goes out,
    // which outbound.test.js covers.
    const kept = await Message.findById(toStranger.body.message.id).lean();
    expect(kept.to.map((a) => a.address)).toEqual(['nobody@elsewhere.example']);
  });

  it('keeps bcc recipients hidden from everyone except the sender and themselves', async () => {
    const { anna, ben, cleo } = await everyone();
    await send(anna, { to: [people.ben.email], bcc: [people.cleo.email], subject: 'Geheim' });

    const [benCopy] = await inboxOf(ben);
    const [cleoCopy] = await inboxOf(cleo);
    const [annaCopy] = await sentOf(anna);

    expect(benCopy.bcc).toEqual([]);
    expect(cleoCopy.bcc.map((a) => a.address)).toEqual([people.cleo.email]);
    expect(annaCopy.bcc.map((a) => a.address)).toEqual([people.cleo.email]);

    // Checked over the API as well, since that is where it would actually leak.
    const res = await request(app).get(`/api/threads/${benCopy.threadId}`).set('Cookie', ben.cookie);
    expect(JSON.stringify(res.body)).not.toContain(people.cleo.email);
  });

  it("threads a reply into the original sender's existing conversation", async () => {
    const { anna, ben } = await everyone();
    const first = await send(anna, { to: [people.ben.email], subject: 'Wohnung', bodyText: 'Ist sie noch frei?' });
    const [benCopy] = await inboxOf(ben);

    const reply = await send(ben, { to: [people.anna.email], threadId: String(benCopy.threadId), bodyText: 'Ja.' });
    expect(reply.status).toBe(201);
    expect(reply.body.message.subject).toBe('Re: Wohnung');

    expect(await Thread.countDocuments({ userId: anna.user._id })).toBe(1);
    const annaThread = await Thread.findById(first.body.thread.id).lean();
    expect(annaThread.messageCount).toBe(2);
    expect([...annaThread.folders].sort()).toEqual(['inbox', 'sent']);

    const [annaSent] = await sentOf(anna);
    const [annaReceived] = await inboxOf(anna);
    expect(annaReceived.inReplyTo).toBe(annaSent.rfcMessageId);
    expect(annaReceived.references).toEqual([annaSent.rfcMessageId]);
    await expectInSync(annaThread._id, benCopy.threadId);
  });

  it('grows the References chain as a conversation goes back and forth', async () => {
    const { anna, ben } = await everyone();
    const first = await send(anna, { to: [people.ben.email], subject: 'Plan' });
    const [benFirst] = await inboxOf(ben);
    await send(ben, { to: [people.anna.email], threadId: String(benFirst.threadId), bodyText: 'eins' });
    await send(anna, { to: [people.ben.email], threadId: first.body.thread.id, bodyText: 'zwei' });

    expect(await Thread.countDocuments({ userId: ben.user._id })).toBe(1);
    const benInbox = await inboxOf(ben);
    expect(benInbox).toHaveLength(2);
    expect(benInbox.at(-1).references).toHaveLength(2);
  });

  it('keeps the References chain from growing without end', async () => {
    const { anna } = await everyone();
    const first = await send(anna, { to: [people.ben.email], subject: 'Lang' });
    const threadId = first.body.thread.id;

    let last;
    for (let i = 0; i < 24; i += 1) {
      last = await send(anna, { to: [people.ben.email], threadId, bodyText: `nummer ${i}` });
    }

    const stored = await Message.findById(last.body.message.id).lean();
    // Trimmed from the old end, so the nearest ancestors are the ones kept.
    expect(stored.references).toHaveLength(20);
    expect(stored.references.at(-1)).toBe(stored.inReplyTo);
    expect(new Set(stored.references).size).toBe(20);
  });

  it('trims the subject', async () => {
    const { anna } = await everyone();
    const res = await send(anna, { to: [people.ben.email], subject: '   Hallo   ' });
    expect(res.body.message.subject).toBe('Hallo');
  });

  it('records a normalised subject on both sides, without the reply prefix', async () => {
    const { anna, ben } = await everyone();
    await send(anna, { to: [people.ben.email], subject: 'Fwd: Termin' });
    const [benCopy] = await inboxOf(ben);
    await send(ben, { to: [people.anna.email], threadId: String(benCopy.threadId) });

    for (const userId of [anna.user._id, ben.user._id]) {
      const thread = await Thread.findOne({ userId }).lean();
      expect(thread.normalizedSubject).toBe('termin');
    }
  });

  it('does not stack reply prefixes on the subject', async () => {
    const { anna, ben } = await everyone();
    await send(anna, { to: [people.ben.email], subject: 'Aw: Re: Wohnung' });
    const [benCopy] = await inboxOf(ben);

    const reply = await send(ben, { to: [people.anna.email], threadId: String(benCopy.threadId) });
    expect(reply.body.message.subject).toBe('Re: Wohnung');
  });

  it('refuses to reply into a thread the sender does not own, and delivers nothing', async () => {
    const { anna, ben } = await everyone();
    const first = await send(anna, { to: [people.cleo.email], subject: 'Privat' });

    const res = await send(ben, { to: [people.anna.email], threadId: first.body.thread.id, bodyText: 'hi' });
    expect(res.status).toBe(404);
    expect(await inboxOf(anna)).toEqual([]);
  });

  it('files mail sent to yourself as one conversation, and replies to it still thread', async () => {
    const { anna } = await everyone();
    const res = await send(anna, { to: [people.anna.email], subject: 'Notiz' });
    expect(res.status).toBe(201);

    const threads = await Thread.find({ userId: anna.user._id }).lean();
    expect(threads).toHaveLength(1);
    expect([...threads[0].folders].sort()).toEqual(['inbox', 'sent']);
    expect(threads[0].hasUnread).toBe(true);
    await expectInSync(threads[0]._id);

    const reply = await send(anna, { to: [people.anna.email], threadId: String(threads[0]._id), bodyText: 'noch was' });
    expect(reply.status).toBe(201);
    expect(await Thread.countDocuments({ userId: anna.user._id })).toBe(1);
    const replyMessage = await Message.findById(reply.body.message.id).lean();
    expect(replyMessage.inReplyTo).toMatch(/@sift\.local>$/);
  });

  it('answers with the thread as it is stored after delivery, including mail to yourself', async () => {
    const { anna } = await everyone();
    const summary = (t) => ({
      folders: [...t.folders].sort(),
      messageCount: t.messageCount,
      hasUnread: t.hasUnread,
      snippet: t.snippet,
      lastMessageAt: new Date(t.lastMessageAt).getTime(),
    });
    // Compared straight after each request, since the next one changes the thread.
    const matchesStored = async (res) => {
      expect(res.status).toBe(201);
      const stored = await Thread.findById(res.body.thread.id).lean();
      expect(summary(res.body.thread)).toEqual(summary(stored));
    };

    const toSelf = await send(anna, { to: [people.anna.email], subject: 'Notiz', bodyText: 'eins' });
    await matchesStored(toSelf);
    expect(toSelf.body.thread).toMatchObject({ messageCount: 2, hasUnread: true });

    await matchesStored(await send(anna, { to: [people.anna.email], threadId: toSelf.body.thread.id, bodyText: 'zwei' }));
    await matchesStored(await send(anna, { to: [people.ben.email], subject: 'Hallo' }));
  });

  it('delivers one copy when the same person is named twice', async () => {
    const { anna, ben } = await everyone();
    await send(anna, { to: [people.ben.email], cc: ['BEN@sift.example'], subject: 'doppelt' });

    expect(await inboxOf(ben)).toHaveLength(1);
    const [sent] = await sentOf(anna);
    expect(sent.cc).toEqual([]);
  });

  it.each([
    ['no recipients', {}, 'to'],
    ['an invalid address', { to: ['not-an-email'] }, 'to.0'],
    ['a malformed thread id', { to: ['ben@sift.example'], threadId: 'nope' }, 'threadId'],
    ['more than 50 recipients', { to: Array.from({ length: 51 }, (_, i) => `p${i}@b.example`) }, 'to'],
  ])('rejects %s', async (_label, body, field) => {
    const { anna } = await everyone();
    const res = await send(anna, body);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });

  it('refuses an HTML body instead of silently dropping it', async () => {
    const { anna, ben } = await everyone();
    const res = await send(anna, { to: [people.ben.email], bodyHtml: '<img src=x onerror=alert(1)>' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.fields)).toMatch(/bodyHtml/);
    expect(await inboxOf(ben)).toEqual([]);
  });
});
