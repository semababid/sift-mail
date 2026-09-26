import crypto from 'node:crypto';
import { Message } from '../models/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { attachmentKey, MAX_ATTACHMENT_BYTES, storage, TooLarge } from './storage/index.js';

const DEFAULT_TYPE = 'application/octet-stream';
// Enough for any real message. The cap keeps a draft from being used as
// general file storage.
export const MAX_ATTACHMENTS = 20;

const MB = 1024 * 1024;
const tooLarge = () =>
  new HttpError(413, `attachments can add up to ${Math.round(MAX_ATTACHMENT_BYTES / MB)} MB per message`, 'attachment_too_large');

const newAttachmentId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

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

// A content type as a browser or mailer declared it, or the neutral default
// when it does not look like one. It is only ever stored and sent back.
const cleanType = (type) => (/^[\w.+-]+\/[\w.+-]+$/.test(type ?? '') ? type.toLowerCase() : DEFAULT_TYPE);

const totalSize = (attachments) => attachments.reduce((sum, attachment) => sum + attachment.size, 0);

// Stores the attachments mailparser found on an imported message and answers
// the list to keep on it. Images the HTML part refers to by cid are left out:
// they are part of that HTML, not files someone attached.
//
// Ids come from each file's position, so fetching the same message a second
// time writes the same keys and overwrites its files.
// Imported mail is taken as it comes, so the limit applies to each file here,
// and a file over it is listed without being kept.
export async function storeAttachments(message, parsedAttachments = []) {
  const files = parsedAttachments.filter((attachment) => !attachment.related);
  const kept = [];

  for (const [index, attachment] of files.entries()) {
    const size = attachment.size ?? attachment.content?.length ?? 0;
    const entry = {
      id: String(index),
      filename: cleanFilename(attachment.filename, index),
      contentType: cleanType(attachment.contentType),
      size,
      storageKey: null,
    };
    if (size <= MAX_ATTACHMENT_BYTES) {
      entry.storageKey = attachmentKey(message.userId, message._id, entry.id);
      await storage.put(entry.storageKey, attachment.content);
    }
    kept.push(entry);
  }

  return kept;
}

// Adds an uploaded file to a draft. The bytes are counted as they arrive and
// the upload stops the moment it would take the message past the limit.
//
// The file is stored before the draft records it, and the draft only records
// it if it is still a draft and still has room: the check and the write are
// one update, so two uploads at once cannot both squeeze under the limit, and
// an upload that lands after the draft was sent is refused. Either way the
// stored file is removed again.
export async function addDraftAttachment(user, draftId, { filename, contentType, stream, declaredSize }) {
  const draft = await Message.findOne({ _id: draftId, userId: user._id, isDraft: true }).select('attachments').lean();
  if (!draft) throw notFound('draft not found');
  if (draft.attachments.length >= MAX_ATTACHMENTS) {
    throw new HttpError(400, `a message can carry up to ${MAX_ATTACHMENTS} attachments`, 'too_many_attachments');
  }

  const room = MAX_ATTACHMENT_BYTES - totalSize(draft.attachments);
  // The declared length is only a hint, but a hint over the limit is enough
  // to refuse before reading a byte.
  if (declaredSize > room) throw tooLarge();

  const id = newAttachmentId();
  const storageKey = attachmentKey(user._id, draftId, id);
  let size;
  try {
    ({ size } = await storage.putStream(storageKey, stream, { limit: room }));
  } catch (err) {
    if (err instanceof TooLarge) throw tooLarge();
    throw err;
  }

  const entry = {
    id,
    filename: cleanFilename(filename, draft.attachments.length),
    contentType: cleanType(contentType),
    size,
    storageKey,
  };
  const updated = await Message.findOneAndUpdate(
    {
      _id: draftId,
      userId: user._id,
      isDraft: true,
      $expr: {
        $and: [
          { $lte: [{ $add: [{ $sum: '$attachments.size' }, size] }, MAX_ATTACHMENT_BYTES] },
          { $lt: [{ $size: '$attachments' }, MAX_ATTACHMENTS] },
        ],
      },
    },
    { $push: { attachments: entry } },
    { new: true },
  );

  if (!updated) {
    await storage.remove(storageKey);
    const stillDraft = await Message.exists({ _id: draftId, userId: user._id, isDraft: true });
    throw stillDraft ? tooLarge() : notFound('draft not found');
  }
  return updated;
}

// Takes one attachment off a draft and deletes its file. Answers the draft as
// it stands after the removal, built from the result of the one write.
// Reading it back afterwards could find nothing if the draft was deleted in
// between, and turn a removal that worked into a 500.
export async function removeDraftAttachment(user, draftId, attachmentId) {
  const before = await Message.findOneAndUpdate(
    { _id: draftId, userId: user._id, isDraft: true, 'attachments.id': attachmentId },
    { $pull: { attachments: { id: attachmentId } } },
    // The version from before the pull, which still says where the file is.
    { new: false },
  ).lean();
  if (!before) throw notFound('attachment not found');

  const removed = before.attachments.find((attachment) => attachment.id === attachmentId);
  if (removed.storageKey) await storage.remove(removed.storageKey);
  return Message.hydrate({ ...before, attachments: before.attachments.filter((attachment) => attachment !== removed) });
}

// Deletes the files behind a message's attachments, once the message is gone.
export async function removeAttachmentFiles(attachments = []) {
  await Promise.all(
    attachments.filter((attachment) => attachment.storageKey).map((attachment) => storage.remove(attachment.storageKey)),
  );
}

// A recipient's own copy of each file, under their own inbox message, so no
// two users ever share a stored file and deleting one person's mail can never
// take another's attachment with it. Files that were never kept stay listed.
export async function copyAttachments(attachments, userId, messageId) {
  const copies = [];
  for (const attachment of attachments) {
    const storageKey = attachment.storageKey ? attachmentKey(userId, messageId, attachment.id) : null;
    if (storageKey) await storage.copy(attachment.storageKey, storageKey);
    copies.push({ ...attachment, storageKey });
  }
  return copies;
}

// The files of a message as Nodemailer takes them, streamed from storage. A
// file that is missing stops the send, so a message never goes out without a
// file its writer saw attached.
export async function attachmentsForSending(attachments = []) {
  const opened = [];
  for (const attachment of attachments) {
    const file = attachment.storageKey ? await storage.open(attachment.storageKey) : null;
    if (!file) {
      for (const done of opened) done.content.destroy();
      throw new HttpError(409, `${attachment.filename} is no longer stored and cannot be sent`, 'attachment_missing');
    }
    opened.push({ filename: attachment.filename, contentType: attachment.contentType, content: file.stream });
  }
  return opened;
}

// An attachment ready to stream, for its owner only. Someone else's message,
// an id it does not have, a file that was never kept and a file that has gone
// missing from storage all get the same 404.
export async function openAttachment(userId, messageId, attachmentId) {
  const message = await Message.findOne({ _id: messageId, userId }).select('attachments').lean();
  const attachment = message?.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment?.storageKey) throw notFound('attachment not found');

  const file = await storage.open(attachment.storageKey);
  if (!file) throw notFound('attachment not found');
  return { ...file, filename: attachment.filename, contentType: attachment.contentType || DEFAULT_TYPE };
}
