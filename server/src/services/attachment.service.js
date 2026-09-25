import { Message } from '../models/index.js';
import { notFound } from '../lib/errors.js';
import { attachmentKey, MAX_ATTACHMENT_BYTES, storage } from './storage/index.js';

const DEFAULT_TYPE = 'application/octet-stream';

// A filename from a message is only ever shown and put in a download header,
// never used as a path, but it is still cut back to its last segment and
// stripped of control characters. Mail that names no file gets a name from
// its position.
export function cleanFilename(name, index) {
  const last = String(name ?? '')
    .split(/[/\\]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return last && last !== '.' && last !== '..' ? last : `attachment-${index + 1}`;
}

// Stores the attachments mailparser found on a message and answers the list
// to keep on it. Images the HTML part refers to by cid are left out: they are
// part of that HTML, not files someone attached.
export async function storeAttachments(message, parsedAttachments = []) {
  const files = parsedAttachments.filter((attachment) => !attachment.related);
  const kept = [];

  for (const [index, attachment] of files.entries()) {
    const size = attachment.size ?? attachment.content?.length ?? 0;
    const entry = {
      filename: cleanFilename(attachment.filename, index),
      contentType: attachment.contentType || DEFAULT_TYPE,
      size,
      storageKey: null,
    };
    if (size <= MAX_ATTACHMENT_BYTES) {
      entry.storageKey = attachmentKey(message.userId, message._id, index);
      await storage.put(entry.storageKey, attachment.content);
    }
    kept.push(entry);
  }

  return kept;
}

// An attachment ready to stream, for its owner only. Someone else's message,
// a position past the end, a file that was never kept and a file that has gone
// missing from storage all get the same 404.
export async function openAttachment(userId, messageId, position) {
  const index = Number(position);
  const message = await Message.findOne({ _id: messageId, userId }).select('attachments').lean();
  const attachment = Number.isInteger(index) && index >= 0 ? message?.attachments[index] : undefined;
  if (!attachment?.storageKey) throw notFound('attachment not found');

  const file = await storage.open(attachment.storageKey);
  if (!file) throw notFound('attachment not found');
  return { ...file, filename: attachment.filename, contentType: attachment.contentType || DEFAULT_TYPE };
}
