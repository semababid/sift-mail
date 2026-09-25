import { pipeline } from 'node:stream';
import * as mail from '../services/mail.service.js';
import { openAttachment } from '../services/attachment.service.js';

// The response is the sender's copy and thread, and nothing about delivery.
// Saying which recipients have Sift accounts would turn this endpoint into the
// account-probing tool the login route goes out of its way not to be.
export async function send(req, res) {
  const { message, thread } = await mail.sendMessage(req.user, req.valid.body);
  res.status(201).json({ message: message.toJSON(), thread: thread.toJSON() });
}

export async function createDraft(req, res) {
  const draft = await mail.createDraft(req.user, req.valid.body);
  res.status(201).json({ draft: draft.toJSON() });
}

export async function updateDraft(req, res) {
  const draft = await mail.updateDraft(req.user, req.params.id, req.valid.body);
  res.json({ draft: draft.toJSON() });
}

export async function deleteDraft(req, res) {
  await mail.deleteDraft(req.user, req.params.id);
  res.status(204).end();
}

export async function sendDraft(req, res) {
  const { message, thread } = await mail.sendDraft(req.user, req.params.id);
  res.status(201).json({ message: message.toJSON(), thread: thread.toJSON() });
}

// The Content-Disposition value RFC 6266 recommends: a plain ASCII name for
// old clients, then the real one in UTF-8. Express writes a name like
// "Kündigung.pdf" as raw Latin-1 bytes, which many browsers show garbled.
function downloadDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// Streams the file from storage rather than reading it into memory first.
//
// Always a download, never shown in the page: an HTML or SVG file opened on
// Sift's own origin could run script with the user's session. The sandbox
// header is there for a browser that opens it anyway.
export async function downloadAttachment(req, res) {
  const file = await openAttachment(req.userId, req.params.id, req.params.index);

  res.set({
    'Content-Disposition': downloadDisposition(file.filename),
    'Content-Type': file.contentType,
    'Content-Length': String(file.size),
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
  });
  pipeline(file.stream, res, (err) => {
    if (err) req.log?.warn({ err: err.message }, 'attachment download stopped early');
  });
}
