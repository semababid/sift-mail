import { simpleParser } from 'mailparser';
import { Message, MailboxSync, Thread } from '../../models/index.js';
import { refreshThread } from '../thread-summary.js';
import { findThreadFor } from '../threading.js';
import { mailingListOf, parseMessageIds, referenceChain } from '../../lib/headers.js';
import { makeSnippet, normalizeSubject } from '../../lib/text.js';
import { logger } from '../../config/logger.js';
import { storeAttachments } from '../attachment.service.js';
import { embedLater } from '../embedding/queue.js';
import { triageLater } from '../triage/queue.js';

const log = logger.child({ worker: 'imap-import' });

// Mail in from an IMAP mailbox, into one Sift user's inbox.
//
// It runs in two passes. The first stores each new message from its envelope
// and a couple of headers, which is cheap to fetch, so a conversation shows up
// in the list straight away. The second fetches the full message, parses it,
// and fills in the text. Either pass can stop at any point and be run again.
//
// `client` is a mailbox as src/services/imap/client.js presents one:
//   open(mailbox)   -> { uidValidity }
//   uids()          -> every UID in the open mailbox
//   headers(uids)   -> [{ uid, flags, internalDate, envelope, references }]
//   source(uid)     -> the raw message, or null once it is gone
// Tests hand in a fake with the same four calls.

// A first import takes only this many of the newest messages. A mailbox with
// ten years in it would otherwise stall the first run for an hour.
export const INITIAL_LIMIT = 200;
// Headers are fetched this many at a time, and the watermark moves after each.
export const HEADER_BATCH = 100;
// Kept in line with what the send API accepts for a body.
export const MAX_BODY_CHARS = 200_000;

const addressesOf = (list = []) =>
  list.filter((person) => person?.address).map((person) => ({ name: person.name || undefined, address: person.address.toLowerCase() }));

const validDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

// A Date header can be missing or nonsense, and then the time the server
// received the message is the better answer, and now is the last resort.
const sentAtOf = ({ envelope, internalDate }) => validDate(envelope?.date) ?? validDate(internalDate) ?? new Date();

// Whether a failure to store one message is down to that message, as opposed
// to the database or the connection. Only the first kind is skipped: the
// second has to stop the batch before the watermark moves, so the next run
// fetches it again.
const isAboutTheMessage = (err) => err instanceof TypeError || err.name === 'ValidationError' || err.name === 'CastError';

// Where a message goes in this mailbox, or null when it is here already.
async function placeFor(user, selfAddresses, fields) {
  if (fields.rfcMessageId) {
    const same = await Message.findOne({ userId: user._id, rfcMessageId: fields.rfcMessageId })
      .select('threadId imap')
      .lean();
    // Imported before, perhaps under an earlier UIDVALIDITY.
    if (same?.imap) return null;
    // The user's own mail coming back: something sent from Sift to the
    // address being synced. It is an inbox copy of a message already stored as
    // sent, so it joins that conversation, and leaves the Message-ID to the
    // sent copy, as mail to yourself does within Sift.
    if (same) return { threadId: same.threadId, rfcMessageId: null };
  }

  const existing = await findThreadFor(user._id, fields, { subjectFallback: true, selfAddresses });
  if (existing) return { threadId: existing, rfcMessageId: fields.rfcMessageId };

  const thread = await Thread.create({
    userId: user._id,
    subject: fields.subject,
    normalizedSubject: normalizeSubject(fields.subject),
    lastMessageAt: fields.sentAt,
  });
  return { threadId: thread._id, rfcMessageId: fields.rfcMessageId, createdThread: true };
}

async function storeHeaders(user, { account, mailbox, uidValidity, selfAddresses }, item) {
  const { envelope = {} } = item;
  const from = addressesOf(envelope.from)[0] ?? { address: 'unknown@invalid' };
  const to = addressesOf(envelope.to);
  const cc = addressesOf(envelope.cc);
  const { inReplyTo, references } = referenceChain({ inReplyTo: envelope.inReplyTo, references: item.references });

  const fields = {
    rfcMessageId: parseMessageIds(envelope.messageId)[0] ?? null,
    inReplyTo,
    references,
    subject: (envelope.subject ?? '').trim(),
    participants: [from, ...to, ...cc].map((person) => person.address),
    sentAt: sentAtOf(item),
  };

  const place = await placeFor(user, selfAddresses, fields);
  if (!place) return false;

  try {
    await Message.create({
      userId: user._id,
      threadId: place.threadId,
      from,
      to,
      cc,
      subject: fields.subject,
      bodyText: '',
      snippet: '',
      folder: 'inbox',
      isRead: item.flags?.has('\\Seen') ?? false,
      sentAt: fields.sentAt,
      rfcMessageId: place.rfcMessageId,
      inReplyTo: fields.inReplyTo,
      references: fields.references,
      imap: { account, mailbox, uidValidity, uid: item.uid },
      bodyStatus: 'pending',
    });
  } catch (err) {
    // Whatever went wrong, a thread made for this message a moment ago is now
    // empty, and refreshing an empty thread deletes it. When the database is
    // what failed, this fails too and the empty thread stays, out of sight: a
    // thread with no messages is in no folder, so nothing lists it.
    if (place.createdThread) await refreshThread(place.threadId).catch(() => {});
    // Already stored: the same UID, or the same Message-ID, got here first.
    if (err.code === 11000) return false;
    throw err;
  }

  await refreshThread(place.threadId);
  return true;
}

// Pass one. Stores every message the mailbox has gained since the last run and
// moves the watermark along with it. Answers how many messages were stored and
// how many were skipped as unreadable, and the mailbox's UIDVALIDITY, which
// pass two needs.
//
// A message that cannot be stored is logged and skipped. Retrying it would
// fail the same way on every run, and the mailbox would never get past it.
export async function importNewMail({ user, client, account, mailbox = 'INBOX', initialLimit = INITIAL_LIMIT }) {
  const { uidValidity } = await client.open(mailbox);
  const key = { userId: user._id, account, mailbox };
  const state = await MailboxSync.findOne(key);
  const fresh = !state || state.uidValidity !== uidValidity;
  const lastUid = fresh ? 0 : state.lastUid;

  // Filtered here rather than asked for as "lastUid+1:*". IMAP reads that
  // range as "from there to the highest UID", and when nothing is newer it
  // hands back the highest message anyway, which would be stored again on
  // every run.
  let wanted = (await client.uids()).filter((uid) => uid > lastUid).sort((a, b) => a - b);
  if (fresh) wanted = wanted.slice(-initialLimit);

  if (fresh) {
    await MailboxSync.updateOne(key, { $set: { uidValidity, lastUid: 0 } }, { upsert: true });
  }

  const selfAddresses = [user.email, account];
  let stored = 0;
  let skipped = 0;
  for (let i = 0; i < wanted.length; i += HEADER_BATCH) {
    const batch = wanted.slice(i, i + HEADER_BATCH);
    const items = await client.headers(batch);
    for (const item of items.sort((a, b) => a.uid - b.uid)) {
      try {
        if (await storeHeaders(user, { account, mailbox, uidValidity, selfAddresses }, item)) stored += 1;
      } catch (err) {
        if (!isAboutTheMessage(err)) throw err;
        skipped += 1;
        log.warn({ err: err.message, mailbox, uid: item.uid }, 'skipped a message that could not be stored');
      }
    }
    // Moved only once the batch is stored. A crash before this line means the
    // batch is fetched again next time, and the UID index turns the repeats away.
    await MailboxSync.updateOne(key, { $set: { lastUid: batch.at(-1) } });
  }

  await MailboxSync.updateOne(key, { $set: { lastSyncAt: new Date() } });
  return { stored, skipped, uidValidity };
}

// Pass two. Fills in the text of up to `limit` messages still waiting for it,
// newest first, since those are the ones someone is about to open. Answers
// how many it finished.
export async function fetchPendingBodies({ user, client, account, mailbox = 'INBOX', uidValidity, limit = 20 }) {
  const pending = await Message.find({
    userId: user._id,
    bodyStatus: 'pending',
    'imap.account': account,
    'imap.mailbox': mailbox,
  })
    .sort({ sentAt: -1 })
    .limit(limit);

  let done = 0;
  for (const message of pending) {
    // A UID from before the mailbox was reset names some other message now,
    // or nothing. Fetching by it could put the wrong text under this header.
    const raw = message.imap.uidValidity === uidValidity ? await client.source(message.imap.uid) : null;

    if (!raw) {
      message.bodyStatus = 'unavailable';
    } else {
      const parsed = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true });
      // mailparser writes a text version of HTML-only mail itself, which is
      // what the reading pane and search both need. The line break that ends
      // the MIME part is not part of what anyone wrote.
      const text = (parsed.text ?? '').trimEnd().slice(0, MAX_BODY_CHARS);
      message.bodyText = text;
      // Kept for the sanitised HTML view in stage 10. Never shown as it is.
      message.bodyHtml = typeof parsed.html === 'string' ? parsed.html.slice(0, MAX_BODY_CHARS) : '';
      message.snippet = makeSnippet(text);
      message.attachments = await storeAttachments(message, parsed.attachments);
      Object.assign(message, mailingListOf(parsed.headers));
      message.bodyStatus = 'complete';
    }

    await message.save();
    await refreshThread(message.threadId);
    // Embedded and sorted into a bucket once its text is final. One whose body
    // could not be fetched is done from its subject, which is better than
    // nothing at all.
    embedLater([message._id]);
    triageLater([message._id]);
    if (message.bodyStatus === 'complete') done += 1;
  }
  return done;
}

// The headers of a message, without its body: everything before the first
// blank line.
function headerBlock(raw) {
  const text = raw.toString('utf8');
  const end = text.search(/\r?\n\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}

// Pass three, for mail imported before Sift read the mailing list headers:
// reads them for up to `limit` such messages, from the headers alone. A message that turns out to come from a list and was already sorted
// by the model is sorted again, since the model did not know. Answers how
// many it read.
//
// A message the server no longer has is marked as not from a list, so it is
// not asked about on every run.
export const listsUnread = ({ userId, account, mailbox, uidValidity }) => ({
  userId,
  bulk: null,
  bodyStatus: 'complete',
  'imap.account': account,
  'imap.mailbox': mailbox,
  'imap.uidValidity': uidValidity,
  // Lets the index on imported mail serve this, which it only does for
  // queries that say they want imported mail.
  'imap.uid': { $type: 'number' },
});

export async function readMailingLists({ user, client, account, mailbox = 'INBOX', uidValidity, limit = 20 }) {
  const unread = await Message.find(listsUnread({ userId: user._id, account, mailbox, uidValidity }))
    .limit(limit)
    .select('imap');

  for (const message of unread) {
    const raw = await client.source(message.imap.uid);
    const list = raw ? mailingListOf((await simpleParser(headerBlock(raw))).headers) : { bulk: false, listName: null };
    await Message.updateOne({ _id: message._id }, { $set: list });
    if (!list.bulk) continue;
    // Only the model's bucket is undone. One the user chose stands, even if
    // they chose it a moment ago.
    const { modifiedCount } = await Message.updateOne(
      { _id: message._id, 'intent.source': 'model' },
      { $set: { 'intent.classifiedAt': null } },
    );
    if (modifiedCount) triageLater([message._id]);
  }
  return unread.length;
}

