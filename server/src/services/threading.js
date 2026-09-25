import { Message, Thread } from '../models/index.js';
import { normalizeSubject } from '../lib/text.js';
import { HIDDEN_FROM_LABELS } from '../lib/constants.js';

// How far apart two messages may be and still be joined by their subject.
// Long enough for a conversation that goes quiet over a weekend, short enough
// that next month's "Rechnung" from the same sender starts its own thread.
export const SUBJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Which conversation a message belongs to, in one user's mailbox.
//
// Headers first, as RFC 5322 defines them: a reply names its parent in
// In-Reply-To and the chain it hangs off in References. Those ids are the only
// reliable signal, and mail that has them is threaded by them alone.
//
// Plenty of real mail arrives without them. Notifications from the same system
// come as separate messages with no chain, and some clients reply without
// setting either header. For that there is the subject fallback, and it is off
// unless asked for: within Sift the sender says whether a message is a reply,
// so guessing there would merge conversations that were deliberately separate.

// The thread of the message this one points at, preferring the direct parent
// over the rest of the chain, newest first.
async function byNamedParent(userId, { inReplyTo, references = [] }) {
  const named = [inReplyTo, ...[...references].reverse()].filter(Boolean);
  if (named.length === 0) return null;

  const found = await Message.find({ userId, rfcMessageId: { $in: named } })
    .select('rfcMessageId threadId')
    .lean();
  if (found.length === 0) return null;

  const threadOf = new Map(found.map((message) => [message.rfcMessageId, message.threadId]));
  return named.map((id) => threadOf.get(id)).find(Boolean) ?? null;
}

// The other direction: a reply that arrived first, and names this message.
// Mail comes out of order often enough to be worth the second lookup, and
// without it the earlier message would start a thread of its own beside the
// reply that answers it.
async function byNamedChild(userId, rfcMessageId) {
  if (!rfcMessageId) return null;

  const child = await Message.findOne({ userId, references: rfcMessageId })
    .sort({ sentAt: 1 })
    .select('threadId')
    .lean();
  return child?.threadId ?? null;
}

// Same subject once the Re:/AW: pile is stripped, someone in common, and close
// enough in time. All three are needed: subject alone joins every "Rechnung"
// ever sent, and a shared address alone joins everything from one sender.
//
// "Someone in common" means someone other than the owner of the mailbox, who
// is on almost everything in it and so tells the two conversations apart not
// at all. The owner can have more than one address, as when an imported Gmail
// inbox is filed under a Sift account. Mail addressed to nobody else is left
// to start its own thread.
//
// A conversation sitting only in trash or spam is left out. Mail that arrives
// after the user threw the thread away belongs in the inbox on its own.
async function bySubject(userId, { subject, participants = [], sentAt }, selfAddresses) {
  const normalizedSubject = normalizeSubject(subject);
  const own = new Set(selfAddresses.map((address) => address.toLowerCase()));
  const addresses = [...new Set(participants.filter(Boolean).map((address) => address.toLowerCase()))].filter(
    (address) => !own.has(address),
  );
  if (!normalizedSubject || addresses.length === 0) return null;

  const around = new Date(sentAt).getTime();
  const thread = await Thread.findOne({
    userId,
    normalizedSubject,
    lastMessageAt: { $gte: new Date(around - SUBJECT_WINDOW_MS), $lte: new Date(around + SUBJECT_WINDOW_MS) },
    'participants.address': { $in: addresses },
    folders: { $elemMatch: { $nin: HIDDEN_FROM_LABELS } },
  })
    .sort({ lastMessageAt: -1 })
    .select('_id')
    .lean();

  return thread?._id ?? null;
}

// `message` is { rfcMessageId, inReplyTo, references, subject, participants,
// sentAt }, with participants the addresses on it. Answers the id of the
// thread it joins, or null when it starts one.
//
// The subject fallback also wants `selfAddresses`, the addresses this mailbox
// belongs to, so it can tell who the message is really between.
export async function findThreadFor(userId, message, { subjectFallback = false, selfAddresses = [] } = {}) {
  const byHeaders = (await byNamedParent(userId, message)) ?? (await byNamedChild(userId, message.rfcMessageId));
  if (byHeaders) return byHeaders;
  return subjectFallback ? bySubject(userId, message, selfAddresses) : null;
}
