import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { readdir, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import pino from 'pino';
import path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Message } from '../src/models/index.js';
import { setOutboundTransport } from '../src/services/outbound.js';
import { addDraftAttachment, MAX_ATTACHMENTS } from '../src/services/attachment.service.js';

const app = createApp();

beforeAll(connect);
afterAll(async () => {
  setOutboundTransport(undefined);
  await disconnect();
});

// The test limit is 1 MB for a whole message; see tests/setup/env.js.
const MB = 1024 * 1024;
const OUTSIDE = 'mara@elsewhere.example';
const people = {
  anna: { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' },
  ben: { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' },
};

// An SMTP server behind a real Nodemailer transport that keeps each message
// as it would arrive, parsed, so a test can read the attachments back.
function fakeSmtp() {
  const received = [];
  const state = { refuse: false };
  const transport = nodemailer.createTransport({
    name: 'fake',
    version: '1',
    send(mail, callback) {
      if (state.refuse) return callback(new Error('451 try again later'));
      mail.message.build(async (err, raw) => {
        if (err) return callback(err);
        received.push(await simpleParser(raw));
        const envelope = mail.message.getEnvelope();
        callback(null, { envelope, messageId: mail.data.messageId, accepted: envelope.to, rejected: [] });
      });
    },
  });
  return { transport, received, state };
}

let anna;
let smtp;
beforeEach(async () => {
  await clearDb();
  await rm(env.ATTACHMENT_DIR, { recursive: true, force: true });
  smtp = fakeSmtp();
  setOutboundTransport(smtp.transport);
  anna = await signIn(app, people.anna);
});

const newDraft = async (who, body = { to: [OUTSIDE], subject: 'Vertrag', bodyText: 'Anbei.' }) =>
  (await request(app).post('/api/drafts').set('Cookie', who.cookie).send(body)).body.draft;

const upload = (who, draftId, bytes, { filename = 'Vertrag.pdf', type = 'application/pdf', as = 'application/octet-stream' } = {}) =>
  request(app)
    .post(`/api/drafts/${draftId}/attachments`)
    .query({ filename, type })
    .set('Cookie', who.cookie)
    .set('Content-Type', as)
    .send(Buffer.from(bytes));

const sendDraft = (who, draftId) => request(app).post(`/api/drafts/${draftId}/send`).set('Cookie', who.cookie);

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const download = (who, messageId, attachmentId) =>
  request(app).get(`/api/messages/${messageId}/attachments/${attachmentId}`).set('Cookie', who.cookie).buffer(true).parse(binary);

// The files stored for one message, by attachment id.
async function filesFor(who, messageId) {
  try {
    return (await readdir(path.join(env.ATTACHMENT_DIR, String(who.user._id), String(messageId)))).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

describe('uploading to a draft', () => {
  it('stores the file and lists it on the draft', async () => {
    const draft = await newDraft(anna);

    const res = await upload(anna, draft.id, '%PDF-1.4 Vertrag');
    expect(res.status).toBe(201);
    const [attachment] = res.body.draft.attachments;
    expect(attachment).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      filename: 'Vertrag.pdf',
      contentType: 'application/pdf',
      size: 16,
      stored: true,
    });

    const back = await download(anna, draft.id, attachment.id);
    expect(back.body.toString()).toBe('%PDF-1.4 Vertrag');
    expect(await filesFor(anna, draft.id)).toEqual([attachment.id]);
  });

  it('keeps each upload, so a draft can carry several files', async () => {
    const draft = await newDraft(anna);
    await upload(anna, draft.id, 'eins', { filename: 'eins.txt', type: 'text/plain' });
    const res = await upload(anna, draft.id, 'zwei', { filename: 'zwei.txt', type: 'text/plain' });

    expect(res.body.draft.attachments.map((a) => a.filename)).toEqual(['eins.txt', 'zwei.txt']);
  });

  it('takes the file as it is, even one that is JSON', async () => {
    const draft = await newDraft(anna);
    const res = await upload(anna, draft.id, '{"a":1}', { filename: 'daten.json', type: 'application/json' });

    const back = await download(anna, draft.id, res.body.draft.attachments[0].id);
    expect(back.body.toString()).toBe('{"a":1}');
  });

  it('refuses a body sent as anything but raw bytes', async () => {
    const draft = await newDraft(anna);
    const res = await upload(anna, draft.id, '{"a":1}', { as: 'application/json' });

    expect(res.status).toBe(415);
    expect(await filesFor(anna, draft.id)).toEqual([]);
  });

  it('wants a filename', async () => {
    const draft = await newDraft(anna);
    const res = await upload(anna, draft.id, 'x', { filename: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
  });

  it('cleans the name and falls back to a neutral type', async () => {
    const draft = await newDraft(anna);
    const res = await upload(anna, draft.id, 'x', { filename: '../../geheim.txt', type: 'nicht/ein typ' });

    expect(res.body.draft.attachments[0]).toMatchObject({ filename: 'geheim.txt', contentType: 'application/octet-stream' });
  });

  it('refuses a file over the limit before reading it, and stores nothing', async () => {
    const draft = await newDraft(anna);
    const res = await upload(anna, draft.id, Buffer.alloc(MB + 1));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('attachment_too_large');
    expect(res.body.error).toBe('attachments can add up to 1 MB per message');
    expect(await filesFor(anna, draft.id)).toEqual([]);
  });

  it('counts the bytes as they arrive, whatever length was claimed', async () => {
    const draft = await newDraft(anna);
    const stream = Readable.from([Buffer.alloc(MB), Buffer.alloc(10)]);

    await expect(
      addDraftAttachment(anna.user, draft.id, { filename: 'lang.bin', stream, declaredSize: 0 }),
    ).rejects.toMatchObject({ status: 413 });
    expect(await filesFor(anna, draft.id)).toEqual([]);
    expect((await Message.findById(draft.id).lean()).attachments).toEqual([]);
  });

  it('applies the limit to the whole message, not to each file', async () => {
    const draft = await newDraft(anna);
    expect((await upload(anna, draft.id, Buffer.alloc(0.6 * MB))).status).toBe(201);

    const second = await upload(anna, draft.id, Buffer.alloc(0.6 * MB));
    expect(second.status).toBe(413);
    expect((await Message.findById(draft.id).lean()).attachments).toHaveLength(1);
    expect(await filesFor(anna, draft.id)).toHaveLength(1);
  });

  it('lets only one of two uploads at once squeeze under the limit', async () => {
    const draft = await newDraft(anna);
    const results = await Promise.all([
      upload(anna, draft.id, Buffer.alloc(0.6 * MB), { filename: 'a.bin' }),
      upload(anna, draft.id, Buffer.alloc(0.6 * MB), { filename: 'b.bin' }),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([201, 413]);
    expect((await Message.findById(draft.id).lean()).attachments).toHaveLength(1);
    expect(await filesFor(anna, draft.id)).toHaveLength(1);
  });

  it(`stops at ${MAX_ATTACHMENTS} files`, async () => {
    const draft = await newDraft(anna);
    for (let i = 0; i < MAX_ATTACHMENTS; i += 1) {
      expect((await upload(anna, draft.id, 'x', { filename: `${i}.txt` })).status).toBe(201);
    }

    const extra = await upload(anna, draft.id, 'x', { filename: 'zu-viel.txt' });
    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('too_many_attachments');
  });

  it('gives someone else’s draft the same 404 as a missing one, and keeps nothing', async () => {
    const draft = await newDraft(anna);
    const ben = await signIn(app, people.ben);

    const res = await upload(ben, draft.id, 'x');
    expect(res.status).toBe(404);
    expect(await filesFor(ben, draft.id)).toEqual([]);
  });

  it('refuses an upload to a draft that has already been sent', async () => {
    const draft = await newDraft(anna);
    await sendDraft(anna, draft.id);

    const res = await upload(anna, draft.id, 'zu spät');
    expect(res.status).toBe(404);
    expect(await filesFor(anna, draft.id)).toEqual([]);
  });
});

// A stream that records whether anything was read from it.
function tripwire() {
  const state = { read: false };
  const stream = new Readable({
    read() {
      state.read = true;
      this.push(Buffer.alloc(10));
      this.push(null);
    },
  });
  return { stream, state };
}

describe('refusing an upload before reading it all', () => {
  it('refuses a claimed length over the limit without reading any of it', async () => {
    const draft = await newDraft(anna);
    const { stream, state } = tripwire();

    await expect(
      addDraftAttachment(anna.user, draft.id, { filename: 'gross.bin', stream, declaredSize: MB + 1 }),
    ).rejects.toMatchObject({ status: 413 });
    expect(state.read).toBe(false);
  });

  it('counts what the draft already carries before reading a new file', async () => {
    const draft = await newDraft(anna);
    await upload(anna, draft.id, Buffer.alloc(0.6 * MB));
    const { stream, state } = tripwire();

    await expect(
      addDraftAttachment(anna.user, draft.id, { filename: 'zweite.bin', stream, declaredSize: 0.6 * MB }),
    ).rejects.toMatchObject({ status: 413 });
    expect(state.read).toBe(false);
  });

  it('stops reading an upload as soon as it passes the limit', async () => {
    const draft = await newDraft(anna);
    let pulled = 0;
    async function* chunks() {
      for (let i = 0; i < 20; i += 1) {
        pulled += 1;
        yield Buffer.alloc(0.3 * MB);
      }
    }

    await expect(
      addDraftAttachment(anna.user, draft.id, {
        filename: 'endlos.bin',
        stream: Readable.from(chunks(), { highWaterMark: 1 }),
        declaredSize: 0,
      }),
    ).rejects.toMatchObject({ status: 413 });
    // A 1 MB limit is passed on the fourth 0.3 MB chunk. Reading on past a
    // few more would mean the limit was only checked at the end.
    expect(pulled).toBeLessThan(8);
    expect(await filesFor(anna, draft.id)).toEqual([]);
  });
});

describe('an upload the client gives up on', () => {
  it('leaves nothing behind, and is not logged as a server fault', async () => {
    const lines = [];
    const sink = new Writable({
      write(chunk, encoding, callback) {
        lines.push(JSON.parse(chunk));
        callback();
      },
    });
    const logged = createApp({ logger: pino({ level: 'info' }, sink) });
    const draft = await newDraft(anna);

    const server = logged.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: `/api/drafts/${draft.id}/attachments?filename=halb.bin`,
        headers: { cookie: anna.cookie, 'content-type': 'application/octet-stream', 'content-length': 500_000 },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(100_000));
      // Half sent, then the tab closes.
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 300);
      }, 100);
    });
    server.close();

    expect(lines.filter((line) => line.level >= 50)).toEqual([]);
    expect(lines.some((line) => line.msg === 'upload abandoned by the client')).toBe(true);
    expect(await filesFor(anna, draft.id)).toEqual([]);
    expect((await Message.findById(draft.id).lean()).attachments).toEqual([]);
  });
});

describe('removing from a draft', () => {
  it('takes the file off the draft and deletes it', async () => {
    const draft = await newDraft(anna);
    const kept = (await upload(anna, draft.id, 'bleibt', { filename: 'bleibt.txt' })).body.draft.attachments[0];
    const gone = (await upload(anna, draft.id, 'weg', { filename: 'weg.txt' })).body.draft.attachments[1];

    const res = await request(app).delete(`/api/drafts/${draft.id}/attachments/${gone.id}`).set('Cookie', anna.cookie);
    expect(res.status).toBe(200);
    expect(res.body.draft.attachments.map((a) => a.id)).toEqual([kept.id]);
    expect(await filesFor(anna, draft.id)).toEqual([kept.id]);
  });

  it('answers with the draft even if it is deleted straight after the removal', async () => {
    const draft = await newDraft(anna);
    const { id } = (await upload(anna, draft.id, 'weg')).body.draft.attachments[0];
    // Reading the draft back would now find nothing.
    vi.spyOn(Message, 'findById').mockResolvedValue(null);

    const res = await request(app).delete(`/api/drafts/${draft.id}/attachments/${id}`).set('Cookie', anna.cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({ id: draft.id, attachments: [] });
  });

  it('answers 404 for an id the draft does not have', async () => {
    const draft = await newDraft(anna);
    const res = await request(app).delete(`/api/drafts/${draft.id}/attachments/nichtda`).set('Cookie', anna.cookie);
    expect(res.status).toBe(404);
  });

  it('deletes every file when the draft is thrown away', async () => {
    const draft = await newDraft(anna);
    await upload(anna, draft.id, 'eins');
    await upload(anna, draft.id, 'zwei');

    await request(app).delete(`/api/drafts/${draft.id}`).set('Cookie', anna.cookie);
    expect(await filesFor(anna, draft.id)).toEqual([]);
  });
});

describe('sending a draft with attachments', () => {
  it('sends the files over SMTP, byte for byte', async () => {
    const draft = await newDraft(anna);
    await upload(anna, draft.id, '%PDF-1.4 Vertrag', { filename: 'Vertrag.pdf', type: 'application/pdf' });
    await upload(anna, draft.id, 'Zeile 1\nZeile 2', { filename: 'Notizen.txt', type: 'text/plain' });

    expect((await sendDraft(anna, draft.id)).status).toBe(201);

    const [delivered] = smtp.received;
    expect(delivered.text.trim()).toBe('Anbei.');
    expect(delivered.attachments.map((a) => [a.filename, a.contentType, a.content.toString()])).toEqual([
      ['Vertrag.pdf', 'application/pdf', '%PDF-1.4 Vertrag'],
      ['Notizen.txt', 'text/plain', 'Zeile 1\nZeile 2'],
    ]);
  });

  it('keeps the files on the sent copy, where the sender can still download them', async () => {
    const draft = await newDraft(anna);
    const { id } = (await upload(anna, draft.id, 'Inhalt')).body.draft.attachments[0];
    await sendDraft(anna, draft.id);

    const sent = await Message.findById(draft.id).lean();
    expect(sent).toMatchObject({ folder: 'sent', isDraft: false });
    expect((await download(anna, draft.id, id)).body.toString()).toBe('Inhalt');
  });

  it('gives a Sift recipient a copy of their own', async () => {
    const ben = await signIn(app, people.ben);
    const draft = await newDraft(anna, { to: [people.ben.email], subject: 'Für dich' });
    const { id } = (await upload(anna, draft.id, 'für Ben')).body.draft.attachments[0];
    await sendDraft(anna, draft.id);

    const benCopy = await Message.findOne({ userId: ben.user._id, folder: 'inbox' }).lean();
    expect(benCopy.attachments).toHaveLength(1);
    expect(benCopy.attachments[0].storageKey.startsWith(`${ben.user._id}/${benCopy._id}/`)).toBe(true);
    expect((await download(ben, benCopy._id, id)).body.toString()).toBe('für Ben');

    // Ben's copy is his: the sender cannot fetch it, and he cannot fetch hers.
    expect((await download(anna, benCopy._id, id)).status).toBe(404);
    expect((await download(ben, draft.id, id)).status).toBe(404);
    // Nothing went over SMTP, since everyone has an account.
    expect(smtp.received).toEqual([]);
  });

  it('refuses to send when a file has gone missing from storage, and leaves the draft as it was', async () => {
    const draft = await newDraft(anna);
    const { id } = (await upload(anna, draft.id, 'verloren')).body.draft.attachments[0];
    await rm(path.join(env.ATTACHMENT_DIR, String(anna.user._id), draft.id, id));

    const res = await sendDraft(anna, draft.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('attachment_missing');
    expect(smtp.received).toEqual([]);
    expect(await Message.findById(draft.id).lean()).toMatchObject({ isDraft: true, folder: 'drafts' });
  });

  it('keeps the draft and its files when the SMTP server refuses', async () => {
    const draft = await newDraft(anna);
    const { id } = (await upload(anna, draft.id, 'nochmal')).body.draft.attachments[0];
    smtp.state.refuse = true;

    expect((await sendDraft(anna, draft.id)).status).toBe(502);
    expect(await Message.findById(draft.id).lean()).toMatchObject({ isDraft: true });

    // And it goes out, file and all, once the server is back.
    smtp.state.refuse = false;
    expect((await sendDraft(anna, draft.id)).status).toBe(201);
    expect(smtp.received[0].attachments[0].content.toString()).toBe('nochmal');
    expect(await filesFor(anna, draft.id)).toEqual([id]);
  });
});
