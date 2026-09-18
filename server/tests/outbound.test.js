import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { Thread, Message } from '../src/models/index.js';
import { setOutboundTransport } from '../src/services/outbound.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);

const people = {
  anna: { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' },
  ben: { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' },
};
const OUTSIDE = 'mara@elsewhere.example';
const OUTSIDE_2 = 'jonas@elsewhere.example';

// Stands in for an SMTP server behind a real Nodemailer transport: records
// what Nodemailer hands it, and can be told to refuse. Each entry in `sent`
// has the envelope the way the server would see it, and the headers as given.
function fakeSmtp() {
  const sent = [];
  const state = { refuse: false };
  const transport = nodemailer.createTransport({
    name: 'fake',
    version: '1',
    send(mail, callback) {
      if (state.refuse) return callback(new Error('451 try again later'));
      const envelope = mail.message.getEnvelope();
      sent.push({ envelope, headers: mail.data });
      callback(null, { envelope, messageId: mail.data.messageId, accepted: envelope.to, rejected: [] });
    },
  });
  return { sent, state, transport };
}

let smtp;
beforeEach(async () => {
  await clearDb();
  smtp = fakeSmtp();
  setOutboundTransport(smtp.transport);
});
afterAll(() => setOutboundTransport(undefined));

const send = (who, body) => request(app).post('/api/messages').set('Cookie', who.cookie).send(body);

describe('mail to addresses outside Sift', () => {
  it('goes out over SMTP with the same Message-ID the stored copy has', async () => {
    const anna = await signIn(app, people.anna);
    const res = await send(anna, { to: [OUTSIDE], subject: 'Hallo', bodyText: 'Wie geht es?' });
    expect(res.status).toBe(201);

    expect(smtp.sent).toHaveLength(1);
    const [mail] = smtp.sent;
    expect(mail.envelope.to).toEqual([OUTSIDE]);
    expect(mail.headers.from).toEqual({ name: 'Anna', address: people.anna.email });
    expect(mail.headers.subject).toBe('Hallo');
    expect(mail.headers.text).toBe('Wie geht es?');

    const stored = await Message.findById(res.body.message.id).lean();
    expect(mail.headers.messageId).toBe(stored.rfcMessageId);
    expect(stored.outbound).toMatchObject({ accepted: [OUTSIDE], rejected: [] });
    expect(stored.outbound.at).toBeInstanceOf(Date);
  });

  it('carries only the outside addresses in the envelope, and everyone in the headers', async () => {
    const anna = await signIn(app, people.anna);
    const ben = await signIn(app, people.ben);
    const res = await send(anna, { to: [people.ben.email, OUTSIDE], cc: [OUTSIDE_2], bcc: ['hidden@elsewhere.example'] });
    expect(res.status).toBe(201);

    const [mail] = smtp.sent;
    expect(mail.envelope.to.sort()).toEqual([OUTSIDE, OUTSIDE_2, 'hidden@elsewhere.example'].sort());
    expect(mail.headers.to.map((a) => a.address)).toEqual([people.ben.email, OUTSIDE]);
    expect(mail.headers.cc.map((a) => a.address)).toEqual([OUTSIDE_2]);
    // No Bcc header. Nodemailer puts bcc in the envelope alone unless asked.
    expect(mail.headers.bcc).toBeUndefined();

    // Ben still gets his copy the internal way.
    expect(await Message.countDocuments({ userId: ben.user._id, folder: 'inbox' })).toBe(1);
  });

  it('sends nothing over SMTP when everyone has a Sift account', async () => {
    const anna = await signIn(app, people.anna);
    await signIn(app, people.ben);
    const res = await send(anna, { to: [people.ben.email], subject: 'Intern' });
    expect(res.status).toBe(201);
    expect(smtp.sent).toEqual([]);
    const stored = await Message.findById(res.body.message.id).lean();
    expect(stored.outbound).toBeNull();
  });

  it('sets In-Reply-To and References on a reply', async () => {
    const anna = await signIn(app, people.anna);
    const first = await send(anna, { to: [OUTSIDE], subject: 'Wohnung' });
    const reply = await send(anna, { to: [OUTSIDE], threadId: first.body.thread.id, bodyText: 'Noch da?' });
    expect(reply.status).toBe(201);

    const [, mail] = smtp.sent;
    const firstId = first.body.message.rfcMessageId;
    expect(mail.headers.inReplyTo).toBe(firstId);
    expect(mail.headers.references).toEqual([firstId]);
    expect(mail.headers.subject).toBe('Re: Wohnung');
  });

  it('fails the whole send when the SMTP server refuses, leaving nothing behind', async () => {
    const anna = await signIn(app, people.anna);
    const ben = await signIn(app, people.ben);
    smtp.state.refuse = true;

    const res = await send(anna, { to: [OUTSIDE, people.ben.email], subject: 'Weg' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('smtp_failed');

    expect(await Message.countDocuments({})).toBe(0);
    expect(await Thread.countDocuments({})).toBe(0);
    expect(await Message.countDocuments({ userId: ben.user._id })).toBe(0);
  });

  it('hands a draft back as a draft when sending it fails at the SMTP server', async () => {
    const anna = await signIn(app, people.anna);
    const created = await request(app)
      .post('/api/drafts')
      .set('Cookie', anna.cookie)
      .send({ to: [OUTSIDE], subject: 'Entwurf', bodyText: 'Text' });
    const draftId = created.body.draft.id;
    smtp.state.refuse = true;

    const failed = await request(app).post(`/api/drafts/${draftId}/send`).set('Cookie', anna.cookie);
    expect(failed.status).toBe(502);
    const draft = await Message.findById(draftId).lean();
    expect(draft).toMatchObject({ isDraft: true, folder: 'drafts', outbound: null });

    // And goes out once the server is back.
    smtp.state.refuse = false;
    const sent = await request(app).post(`/api/drafts/${draftId}/send`).set('Cookie', anna.cookie);
    expect(sent.status).toBe(201);
    expect(smtp.sent).toHaveLength(1);
    expect((await Message.findById(draftId).lean()).folder).toBe('sent');
  });

  it('stores mail to outside addresses without sending it when no SMTP server is set up', async () => {
    setOutboundTransport(null);
    const anna = await signIn(app, people.anna);
    const res = await send(anna, { to: [OUTSIDE], subject: 'Nirgendwo' });
    expect(res.status).toBe(201);
    const stored = await Message.findById(res.body.message.id).lean();
    expect(stored.folder).toBe('sent');
    expect(stored.outbound).toBeNull();
  });
});
