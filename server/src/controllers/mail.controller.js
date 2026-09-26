import { pipeline } from 'node:stream';
import * as mail from '../services/mail.service.js';
import { addDraftAttachment, openAttachment, removeDraftAttachment } from '../services/attachment.service.js';
import { HttpError } from '../lib/errors.js';

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

// Streams the file from storage, so a large one is never held in memory whole.
//
// Always a download, never shown in the page: an HTML or SVG file opened on
// Sift's own origin could run script with the user's session. The sandbox
// header is there for a browser that opens it anyway.
export async function downloadAttachment(req, res) {
  const file = await openAttachment(req.userId, req.params.id, req.params.attachmentId);

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

// A file for a draft, sent as the raw request body with its name and type in
// the query string. No multipart parsing: the body streams straight to storage.
//
// It has to arrive as application/octet-stream. The JSON parser reads any
// body labelled JSON before a route sees it, which would leave an uploaded
// .json file empty by the time it got here.
export async function uploadAttachment(req, res) {
  if (!req.is('application/octet-stream')) {
    throw new HttpError(415, 'send the file as application/octet-stream', 'unsupported_media_type');
  }
  const { filename, type } = req.valid.query;
  const declared = Number(req.get('content-length'));
  let draft;
  try {
    draft = await addDraftAttachment(req.user, req.params.id, {
      filename,
      contentType: type,
      stream: req,
      declaredSize: Number.isFinite(declared) ? declared : 0,
    });
  } catch (err) {
    // The client closed the connection partway, as when someone closes the
    // tab during an upload. Storage has already thrown the part away, and
    // there is nobody left to answer, so it is not logged as a server fault.
    // The socket is what says so. `req.destroyed` is no use here: Node sets it
    // once a body has been read to the end, which would swallow every refusal
    // that comes after a complete upload and leave the client waiting.
    if (err.code === 'ECONNRESET' && req.socket.destroyed) {
      req.log?.info({ draftId: req.params.id }, 'upload abandoned by the client');
      return;
    }
    throw err;
  }
  res.status(201).json({ draft: draft.toJSON() });
}

export async function removeAttachment(req, res) {
  const draft = await removeDraftAttachment(req.user, req.params.id, req.params.attachmentId);
  res.json({ draft: draft.toJSON() });
}
