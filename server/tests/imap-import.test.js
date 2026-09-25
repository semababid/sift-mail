import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn, threadSummaryProblems } from './helpers.js';
import { createApp } from '../src/app.js';
import { Message, MailboxSync, Thread } from '../src/models/index.js';
import { fetchPendingBodies, importNewMail, MAX_BODY_CHARS } from '../src/services/imap/importer.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);

const ACCOUNT = 'sync@mail.example';
const MARA = { name: 'Mara Klein', address: 'mara@elsewhere.example' };
const OWNER = { name: 'Semab', address: 'semab@sift.example' };

let owner;
beforeEach(async () => {
  await clearDb();
  owner = await signIn(app);
});

// The raw message a server would hand over for a UID.
function mime({ from, to, subject, messageId, inReplyTo, references, date, text, html }) {
  const headers = [
    `From: ${from.name} <${from.address}>`,
    `To: ${to.map((person) => person.address).join(', ')}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    messageId && `Message-ID: ${messageId}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`,
    references && `References: ${references}`,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  if (text !== undefined && html !== undefined) {
    return Buffer.from(
      [
        ...headers,
        'Content-Type: multipart/alternative; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        text,
        '--b',
        'Content-Type: text/html; charset=utf-8',
        '',
        html,
        '--b--',
        '',
      ].join('\r\n'),
    );
  }
  const type = html !== undefined ? 'text/html' : 'text/plain';
  return Buffer.from([...headers, `Content-Type: ${type}; charset=utf-8`, '', html ?? text ?? '', ''].join('\r\n'));
}

// One message on the fake server, in both forms the importer asks for.
function mail(uid, overrides = {}) {
  const fields = {
    from: MARA,
    to: [{ address: ACCOUNT }],
    subject: `Nachricht ${uid}`,
    messageId: `<m${uid}@elsewhere.example>`,
    inReplyTo: undefined,
    references: undefined,
    date: new Date(Date.UTC(2026, 4, 1, 9, uid)),
    text: `Text ${uid}`,
    html: undefined,
    seen: false,
    ...overrides,
  };
  return {
    uid,
    flags: new Set(fields.seen ? ['\\Seen'] : []),
    internalDate: fields.date,
    envelope: {
      date: fields.date,
      subject: fields.subject,
      messageId: fields.messageId,
      inReplyTo: fields.inReplyTo,
      from: [fields.from],
      to: fields.to,
      cc: [],
    },
    references: fields.references ?? '',
    raw: mime(fields),
  };
}

// A mailbox on an IMAP server, with the four calls the importer makes.
function fakeMailbox(messages = [], { uidValidity = '7' } = {}) {
  const box = new Map(messages.map((message) => [message.uid, message]));
  const state = { uidValidity, headerRequests: [], sourceRequests: [] };
  const client = {
    async open() {
      return { uidValidity: state.uidValidity };
    },
    async uids() {
      return [...box.keys()];
    },
    async headers(uids) {
      state.headerRequests.push([...uids]);
      return uids.filter((uid) => box.has(uid)).map((uid) => {
        const { raw, ...item } = box.get(uid);
        return item;
      });
    },
    async source(uid) {
      state.sourceRequests.push(uid);
      return box.get(uid)?.raw ?? null;
    },
  };
  return { client, state, box, add: (message) => box.set(message.uid, message) };
}

const run = (client, extra = {}) => importNewMail({ user: owner.user, client, account: ACCOUNT, ...extra });
const bodies = (client, uidValidity = '7') => fetchPendingBodies({ user: owner.user, client, account: ACCOUNT, uidValidity });
const inbox = () => Message.find({ userId: owner.user._id, folder: 'inbox' }).sort({ sentAt: 1 }).lean();

describe('importing headers', () => {
  it('stores new mail in the owner’s inbox from its headers, with the text still to come', async () => {
    const { client } = fakeMailbox([mail(1), mail(2, { seen: true })]);

    const { stored, uidValidity } = await run(client);
    expect(stored).toBe(2);
    expect(uidValidity).toBe('7');

    const [first, second] = await inbox();
    expect(first).toMatchObject({
      subject: 'Nachricht 1',
      rfcMessageId: '<m1@elsewhere.example>',
      bodyStatus: 'pending',
      bodyText: '',
      isRead: false,
      imap: { account: ACCOUNT, mailbox: 'INBOX', uidValidity: '7', uid: 1 },
    });
    expect(first.from).toEqual({ name: 'Mara Klein', address: MARA.address });
    expect(second.isRead).toBe(true);

    const threads = await Thread.find({ userId: owner.user._id }).lean();
    expect(threads).toHaveLength(2);
    for (const thread of threads) expect(await threadSummaryProblems(thread._id)).toEqual([]);
  });

  it('asks only for what is new on the next run, and stores nothing twice', async () => {
    const mailbox = fakeMailbox([mail(1), mail(2)]);
    await run(mailbox.client);
    mailbox.add(mail(5));

    const { stored } = await run(mailbox.client);
    expect(stored).toBe(1);
    expect(mailbox.state.headerRequests).toEqual([[1, 2], [5]]);
    expect(await inbox()).toHaveLength(3);
    expect((await MailboxSync.findOne({ userId: owner.user._id }).lean()).lastUid).toBe(5);
  });

  it('fetches nothing when nothing is new', async () => {
    const mailbox = fakeMailbox([mail(1), mail(2)]);
    await run(mailbox.client);

    const { stored } = await run(mailbox.client);
    expect(stored).toBe(0);
    // Not the highest message again, which "3:*" would have returned.
    expect(mailbox.state.headerRequests).toEqual([[1, 2]]);
  });

  it('takes only the newest messages on a first import', async () => {
    const { client } = fakeMailbox(Array.from({ length: 10 }, (_, i) => mail(i + 1)));

    await run(client, { initialLimit: 3 });
    expect((await inbox()).map((m) => m.imap.uid)).toEqual([8, 9, 10]);
  });

  it('turns a repeated UID away, as after a crash before the watermark moved', async () => {
    const mailbox = fakeMailbox([mail(1)]);
    await run(mailbox.client);
    await MailboxSync.updateOne({ userId: owner.user._id }, { $set: { lastUid: 0 } });

    const { stored } = await run(mailbox.client);
    expect(stored).toBe(0);
    expect(await inbox()).toHaveLength(1);
    expect(await Thread.countDocuments({ userId: owner.user._id })).toBe(1);
  });

  it('turns a repeated UID away even for mail with no Message-ID, leaving no empty thread', async () => {
    // No subject either, so nothing can match it to its earlier copy and a
    // thread is made for it before the UID index turns it away.
    const mailbox = fakeMailbox([mail(1, { messageId: undefined, subject: '' })]);
    await run(mailbox.client);
    await MailboxSync.updateOne({ userId: owner.user._id }, { $set: { lastUid: 0 } });

    await run(mailbox.client);
    expect(await inbox()).toHaveLength(1);
    expect(await Thread.countDocuments({ userId: owner.user._id })).toBe(1);
  });

  it('starts over when the server resets UIDVALIDITY, without storing any message twice', async () => {
    const mailbox = fakeMailbox([mail(1), mail(2)]);
    await run(mailbox.client);

    // Renumbered: the same two messages, now under new UIDs, and one more.
    mailbox.state.uidValidity = '8';
    mailbox.box.clear();
    [mail(11, { messageId: '<m1@elsewhere.example>' }), mail(12, { messageId: '<m2@elsewhere.example>' }), mail(13)].forEach(mailbox.add);

    const { stored } = await run(mailbox.client);
    expect(stored).toBe(1);
    expect(await inbox()).toHaveLength(3);
    expect(await MailboxSync.findOne({ userId: owner.user._id }).lean()).toMatchObject({ uidValidity: '8', lastUid: 13 });
  });

  it('skips a message that cannot be stored, and carries on past it', async () => {
    const broken = mail(2);
    broken.envelope.from = [{ name: 'Kaputt', address: 42 }];
    const { client } = fakeMailbox([mail(1), broken, mail(3)]);

    const { stored, skipped } = await run(client);
    expect({ stored, skipped }).toEqual({ stored: 2, skipped: 1 });
    expect((await inbox()).map((m) => m.imap.uid)).toEqual([1, 3]);
    expect((await MailboxSync.findOne({ userId: owner.user._id }).lean()).lastUid).toBe(3);
  });

  it('dates a message with no usable date by when it arrived, or failing that by now', async () => {
    const { client } = fakeMailbox([
      { ...mail(1), envelope: { ...mail(1).envelope, date: 'kein Datum' }, internalDate: new Date(Date.UTC(2026, 4, 3)) },
      { ...mail(2), envelope: { ...mail(2).envelope, date: undefined }, internalDate: 'auch keins' },
    ]);
    const before = Date.now();
    await run(client);

    const [first, second] = await Message.find({ userId: owner.user._id }).sort({ 'imap.uid': 1 }).lean();
    expect(first.sentAt.toISOString()).toBe('2026-05-03T00:00:00.000Z');
    expect(second.sentAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('keeps the watermark where it was when the database fails partway through a batch', async () => {
    const mailbox = fakeMailbox([mail(1), mail(2), mail(3)]);
    const create = Message.create.bind(Message);
    let calls = 0;
    const spy = vi.spyOn(Message, 'create').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) return Promise.reject(Object.assign(new Error('connection lost'), { name: 'MongoNetworkError' }));
      return create(...args);
    });

    await expect(run(mailbox.client)).rejects.toThrow('connection lost');
    spy.mockRestore();
    expect((await MailboxSync.findOne({ userId: owner.user._id }).lean()).lastUid).toBe(0);

    // The next run fetches the batch again and stores the rest, once each.
    await run(mailbox.client);
    expect((await inbox()).map((m) => m.imap.uid)).toEqual([1, 2, 3]);
    expect(await Thread.countDocuments({ userId: owner.user._id })).toBe(3);
  });

  it('moves the watermark a batch at a time', async () => {
    const mailbox = fakeMailbox(Array.from({ length: 150 }, (_, i) => mail(i + 1)));
    await run(mailbox.client, { initialLimit: 500 });

    expect(mailbox.state.headerRequests.map((batch) => batch.length)).toEqual([100, 50]);
    expect((await MailboxSync.findOne({ userId: owner.user._id }).lean()).lastUid).toBe(150);
  });
});

describe('threading imported mail', () => {
  it('files a reply to mail sent from Sift under the conversation it answers', async () => {
    const sent = await request(app)
      .post('/api/messages')
      .set('Cookie', owner.cookie)
      .send({ to: [MARA.address], subject: 'Wohnung', bodyText: 'Ist sie noch frei?' });
    const { rfcMessageId } = await Message.findById(sent.body.message.id).lean();

    const { client } = fakeMailbox([
      mail(1, { subject: 'Re: Wohnung', inReplyTo: rfcMessageId, references: rfcMessageId, to: [{ address: ACCOUNT }] }),
    ]);
    await run(client);

    const thread = await Thread.findById(sent.body.thread.id).lean();
    expect(thread.messageCount).toBe(2);
    expect([...thread.folders].sort()).toEqual(['inbox', 'sent']);
    expect(thread.hasUnread).toBe(true);
    expect(await Thread.countDocuments({ userId: owner.user._id })).toBe(1);
  });

  it('files mail Sift sent to the synced address itself with its sent copy, once', async () => {
    const sent = await request(app)
      .post('/api/messages')
      .set('Cookie', owner.cookie)
      .send({ to: [ACCOUNT], subject: 'Notiz', bodyText: 'an mich' });
    const { rfcMessageId } = await Message.findById(sent.body.message.id).lean();

    const { client } = fakeMailbox([mail(1, { from: OWNER, subject: 'Notiz', messageId: rfcMessageId })]);
    await run(client);

    const messages = await Message.find({ userId: owner.user._id }).lean();
    expect(messages.map((m) => m.folder).sort()).toEqual(['inbox', 'sent']);
    const inboxCopy = messages.find((m) => m.folder === 'inbox');
    expect(String(inboxCopy.threadId)).toBe(sent.body.thread.id);
    // The id stays with the sent copy, as for mail to yourself within Sift.
    expect(inboxCopy.rfcMessageId).toBeNull();

    // And a second import does not add it again.
    await MailboxSync.updateOne({ userId: owner.user._id }, { $set: { lastUid: 0 } });
    await run(client);
    expect(await Message.countDocuments({ userId: owner.user._id })).toBe(2);
  });

  it('joins headerless mail to a recent conversation with the same subject and sender', async () => {
    const { client } = fakeMailbox([
      mail(1, { subject: 'Nebenkosten 2025', messageId: undefined }),
      mail(2, { subject: 'AW: Nebenkosten 2025', messageId: undefined, date: new Date(Date.UTC(2026, 4, 2)) }),
    ]);
    await run(client);

    expect(await Thread.countDocuments({ userId: owner.user._id })).toBe(1);
  });

  it('does not join two conversations because both were addressed to the synced account', async () => {
    const other = { name: 'Jonas', address: 'jonas@elsewhere.example' };
    const { client } = fakeMailbox([
      mail(1, { subject: 'Rechnung', messageId: undefined }),
      mail(2, { subject: 'Rechnung', messageId: undefined, from: other }),
    ]);
    await run(client);

    expect(await Thread.countDocuments({ userId: owner.user._id })).toBe(2);
  });
});

describe('fetching bodies', () => {
  it('fills in the text and the snippet, and the thread picks it up', async () => {
    const { client } = fakeMailbox([mail(1, { text: 'Hallo Semab,\n\ndie Wohnung ist noch frei.' })]);
    await run(client);

    expect(await bodies(client)).toBe(1);
    const [message] = await inbox();
    expect(message).toMatchObject({ bodyStatus: 'complete', bodyText: 'Hallo Semab,\n\ndie Wohnung ist noch frei.' });
    expect(message.snippet).toBe('Hallo Semab, die Wohnung ist noch frei.');
    const thread = await Thread.findById(message.threadId).lean();
    expect(thread.snippet).toBe('Hallo Semab, die Wohnung ist noch frei.');
    expect(await threadSummaryProblems(thread._id)).toEqual([]);
  });

  it('writes a text version of mail that only came as HTML, and keeps the HTML aside', async () => {
    const { client } = fakeMailbox([mail(1, { text: undefined, html: '<p>Nur <b>HTML</b></p><script>alert(1)</script>' })]);
    await run(client);
    await bodies(client);

    const [message] = await inbox();
    expect(message.bodyText).toContain('Nur HTML');
    expect(message.bodyText).not.toContain('<b>');
    expect(message.bodyHtml).toContain('<b>HTML</b>');
  });

  it('prefers the plain part of mail that has both', async () => {
    const { client } = fakeMailbox([mail(1, { text: 'Klartext', html: '<p>Formatiert</p>' })]);
    await run(client);
    await bodies(client);

    const [message] = await inbox();
    expect(message.bodyText.trim()).toBe('Klartext');
    expect(message.bodyHtml).toContain('Formatiert');
  });

  it('works through the newest first, a batch at a time', async () => {
    const mailbox = fakeMailbox(Array.from({ length: 5 }, (_, i) => mail(i + 1)));
    await run(mailbox.client);

    await fetchPendingBodies({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7', limit: 2 });
    expect(mailbox.state.sourceRequests).toEqual([5, 4]);
    expect(await Message.countDocuments({ bodyStatus: 'pending' })).toBe(3);
  });

  it('gives up on a message deleted on the server, and says so', async () => {
    const mailbox = fakeMailbox([mail(1)]);
    await run(mailbox.client);
    mailbox.box.delete(1);

    expect(await bodies(mailbox.client)).toBe(0);
    const [message] = await inbox();
    expect(message.bodyStatus).toBe('unavailable');
  });

  it('never fetches by a UID from before the mailbox was reset', async () => {
    const mailbox = fakeMailbox([mail(1)]);
    await run(mailbox.client);

    await bodies(mailbox.client, '8');
    expect(mailbox.state.sourceRequests).toEqual([]);
    expect((await inbox())[0].bodyStatus).toBe('unavailable');
  });

  it('cuts a very long body down to the size the API accepts', async () => {
    const { client } = fakeMailbox([mail(1, { text: 'x'.repeat(MAX_BODY_CHARS + 500) })]);
    await run(client);
    await bodies(client);

    expect((await inbox())[0].bodyText.length).toBe(MAX_BODY_CHARS);
  });

  it('shows imported mail over the API, pending first and complete after', async () => {
    const { client } = fakeMailbox([mail(1)]);
    await run(client);
    const [stored] = await inbox();

    const before = await request(app).get(`/api/threads/${stored.threadId}`).set('Cookie', owner.cookie);
    expect(before.body.messages[0].bodyStatus).toBe('pending');

    await bodies(client);
    const after = await request(app).get(`/api/threads/${stored.threadId}`).set('Cookie', owner.cookie);
    expect(after.body.messages[0]).toMatchObject({ bodyStatus: 'complete', bodyText: 'Text 1' });
  });
});
