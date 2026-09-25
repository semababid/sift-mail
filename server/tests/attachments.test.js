import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Message } from '../src/models/index.js';
import { fetchPendingBodies, importNewMail } from '../src/services/imap/importer.js';
import { diskStorage } from '../src/services/storage/disk.js';
import { ACCOUNT, fakeMailbox, mail } from './imap-fixtures.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);

let owner;
beforeEach(async () => {
  await clearDb();
  await rm(env.ATTACHMENT_DIR, { recursive: true, force: true });
  owner = await signIn(app);
});

const MB = 1024 * 1024;
const PDF = { filename: 'Mietvertrag.pdf', contentType: 'application/pdf', content: '%PDF-1.4 der Vertrag' };

// Imports these messages and fetches their bodies, as the sync worker does.
async function importMail(...messages) {
  const mailbox = fakeMailbox(messages);
  await importNewMail({ user: owner.user, client: mailbox.client, account: ACCOUNT });
  await fetchPendingBodies({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
  return mailbox;
}

const stored = () => Message.findOne({ userId: owner.user._id, folder: 'inbox' }).lean();
const filesOf = async (message) => readdir(path.join(env.ATTACHMENT_DIR, String(owner.user._id), String(message._id)));

// Collects a response body as bytes, whatever its type.
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const download = (who, messageId, attachmentId) =>
  request(app).get(`/api/messages/${messageId}/attachments/${attachmentId}`).set('Cookie', who.cookie).buffer(true).parse(binary);

describe('attachments on imported mail', () => {
  it('stores each attached file and lists it on the message', async () => {
    await importMail(mail(1, { attachments: [PDF, { filename: 'Foto.jpg', contentType: 'image/jpeg', content: 'jpeg-bytes' }] }));

    const message = await stored();
    expect(message.attachments).toEqual([
      { id: '0', filename: 'Mietvertrag.pdf', contentType: 'application/pdf', size: PDF.content.length, storageKey: expect.any(String) },
      { id: '1', filename: 'Foto.jpg', contentType: 'image/jpeg', size: 10, storageKey: expect.any(String) },
    ]);
    const onDisk = await readFile(path.join(env.ATTACHMENT_DIR, message.attachments[0].storageKey), 'utf8');
    expect(onDisk).toBe(PDF.content);
    // The text of the message is still there beside them.
    expect(message.bodyText).toBe('Text 1');
  });

  it('shows the list over the API without saying where the files are kept', async () => {
    await importMail(mail(1, { attachments: [PDF] }));
    const message = await stored();

    const res = await request(app).get(`/api/threads/${message.threadId}`).set('Cookie', owner.cookie);
    expect(res.body.messages[0].attachments).toEqual([
      { id: '0', filename: 'Mietvertrag.pdf', contentType: 'application/pdf', size: PDF.content.length, stored: true },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(String(owner.user._id) + '/');
  });

  it('lists a file over the size limit without keeping it', async () => {
    await importMail(mail(1, { attachments: [{ filename: 'Video.mp4', contentType: 'video/mp4', content: Buffer.alloc(MB + 1) }] }));

    const message = await stored();
    expect(message.attachments).toEqual([
      { id: '0', filename: 'Video.mp4', contentType: 'video/mp4', size: MB + 1, storageKey: null },
    ]);
    await expect(filesOf(message)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a file of exactly the limit', async () => {
    await importMail(mail(1, { attachments: [{ filename: 'Grenze.bin', contentType: 'application/octet-stream', content: Buffer.alloc(MB) }] }));
    expect((await stored()).attachments[0].storageKey).not.toBeNull();
  });

  it('leaves out images the HTML part shows inline', async () => {
    await importMail(
      mail(1, {
        text: undefined,
        html: '<p>Logo: <img src="cid:logo"></p>',
        attachments: [{ filename: 'logo.png', contentType: 'image/png', content: 'png', cid: 'logo' }, PDF],
      }),
    );

    expect((await stored()).attachments.map((a) => a.filename)).toEqual(['Mietvertrag.pdf']);
  });

  it('keeps only the last part of a filename, and names a file that came without one', async () => {
    await importMail(
      mail(1, {
        attachments: [
          { filename: '../../etc/passwd', contentType: 'text/plain', content: 'x' },
          { filename: undefined, contentType: 'application/octet-stream', content: 'y' },
        ],
      }),
    );

    expect((await stored()).attachments.map((a) => a.filename)).toEqual(['passwd', 'attachment-2']);
  });

  it('replaces the files rather than adding more when a message is fetched again', async () => {
    const mailbox = await importMail(mail(1, { attachments: [PDF] }));
    await Message.updateMany({ userId: owner.user._id }, { $set: { bodyStatus: 'pending' } });
    await fetchPendingBodies({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });

    const message = await stored();
    expect(message.attachments).toHaveLength(1);
    expect(await filesOf(message)).toEqual(['0']);
  });
});

describe('downloading an attachment', () => {
  it('streams the file to its owner as a download', async () => {
    await importMail(mail(1, { attachments: [PDF] }));
    const message = await stored();

    const res = await download(owner, message._id, 0);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(PDF.content);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(PDF.content.length));
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Mietvertrag.pdf"; filename*=UTF-8''Mietvertrag.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('offers an HTML file as a download too, never as a page', async () => {
    await importMail(mail(1, { attachments: [{ filename: 'seite.html', contentType: 'text/html', content: '<script>alert(1)</script>' }] }));
    const message = await stored();

    const res = await download(owner, message._id, 0);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('writes a name with umlauts so browsers read it back correctly', async () => {
    await importMail(mail(1, { attachments: [{ ...PDF, filename: 'Kündigung.pdf' }] }));
    const message = await stored();

    const res = await download(owner, message._id, 0);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="K_ndigung.pdf"; filename*=UTF-8''K%C3%BCndigung.pdf`);
  });

  it('keeps quotes and odd characters in a name from breaking the header', async () => {
    await importMail(mail(1, { attachments: [PDF] }));
    // Set on the stored message, since a MIME parser would already have taken
    // the quotes out of a header that carried them unescaped.
    await Message.updateOne({ userId: owner.user._id }, { $set: { 'attachments.0.filename': 'Angebot (final) "neu".pdf' } });
    const message = await stored();

    const res = await download(owner, message._id, 0);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="Angebot (final) _neu_.pdf"; filename*=UTF-8''Angebot%20%28final%29%20%22neu%22.pdf`,
    );
  });

  it('gives anyone but the owner the same 404 as for nothing at all', async () => {
    await importMail(mail(1, { attachments: [PDF] }));
    const message = await stored();
    const stranger = await signIn(app, { email: 'fremd@sift.example', password: 'correct-horse', name: 'Fremd' });

    const res = await download(stranger, message._id, 0);
    expect(res.status).toBe(404);
  });

  it.each([
    ['an id the message does not have', '1'],
    ['an id that is not one', 'erste'],
  ])('answers 404 for %s', async (_case, attachmentId) => {
    await importMail(mail(1, { attachments: [PDF] }));
    const res = await download(owner, (await stored())._id, attachmentId);
    expect(res.status).toBe(404);
  });

  it('answers 404 for a message id that cannot exist', async () => {
    const res = await download(owner, 'not-an-id', 0);
    expect(res.status).toBe(404);
  });

  it('answers 404 for a file that was listed but not kept', async () => {
    await importMail(mail(1, { attachments: [{ filename: 'Gross.bin', contentType: 'application/octet-stream', content: Buffer.alloc(MB + 1) }] }));
    const res = await download(owner, (await stored())._id, 0);
    expect(res.status).toBe(404);
  });

  it('answers 404, not a broken download, for a file gone from storage', async () => {
    await importMail(mail(1, { attachments: [PDF] }));
    const message = await stored();
    await rm(path.join(env.ATTACHMENT_DIR, message.attachments[0].storageKey));

    const res = await download(owner, message._id, 0);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: 'not_found' });
  });

  it('needs a session', async () => {
    await importMail(mail(1, { attachments: [PDF] }));
    const res = await request(app).get(`/api/messages/${(await stored())._id}/attachments/0`);
    expect(res.status).toBe(401);
  });
});

describe('disk storage', () => {
  it('refuses a key that would reach outside its folder', async () => {
    const storage = diskStorage(env.ATTACHMENT_DIR);
    await expect(storage.put('../elsewhere', 'x')).rejects.toThrow('escapes the storage root');
    await expect(storage.open('../../etc/hosts')).rejects.toThrow('escapes the storage root');
  });

  it('answers null for a key with nothing stored, and removes quietly', async () => {
    const storage = diskStorage(env.ATTACHMENT_DIR);
    expect(await storage.open('nobody/nothing/0')).toBeNull();
    await expect(storage.remove('nobody/nothing/0')).resolves.toBeUndefined();
  });
});
