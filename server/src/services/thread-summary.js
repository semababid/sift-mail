import { Thread, Message } from '../models/index.js';
import { normalizeSubject } from '../lib/text.js';
import { TRIAGE_FOLDERS } from '../lib/constants.js';

// Rebuilds a thread's stored summary from the messages under it.
//
// Every write that touches a message calls this rather than nudging counters
// by hand. A thread list read far more often than mail changes is the reason
// the summary is stored at all; recomputing it on write keeps it correct by
// construction, where incrementing fields in each code path drifts the first
// time one of them forgets.
//
// Drafts put a thread in the drafts folder but only decide the summary when
// nothing else is in the thread. Starting a reply should not push a
// conversation to the top of the inbox or replace its preview with a
// half-written sentence.
//
// The bucket is that of the newest received message with one: what the
// conversation asks of its owner now. One rule changes the model's verdict:
// a conversation the model said needs a reply, which its owner has since
// answered, is waiting on the other side. A bucket the user chose stands as
// they chose it.
function bucketOf(real) {
  const received = real.filter((m) => TRIAGE_FOLDERS.includes(m.folder) && m.intent?.label);
  const newest = received.at(-1);
  if (!newest) return { bucket: null, bucketSource: null };

  const source = newest.intent.source === 'user' ? 'user' : 'model';
  const answered = real.some((m) => m.folder === 'sent' && m.sentAt > newest.sentAt);
  if (source === 'model' && newest.intent.label === 'needs_reply' && answered) {
    return { bucket: 'waiting_on_them', bucketSource: 'model' };
  }
  return { bucket: newest.intent.label, bucketSource: source };
}

export async function refreshThread(threadId) {
  const messages = await Message.find({ threadId })
    .select('from to cc subject snippet folder isRead isStarred isDraft sentAt intent')
    .sort({ sentAt: 1, _id: 1 })
    .lean();

  if (messages.length === 0) {
    await Thread.deleteOne({ _id: threadId });
    return null;
  }

  const real = messages.filter((m) => !m.isDraft);
  const basis = real.length > 0 ? real : messages;
  const last = basis.at(-1);

  // One entry per address. A later message can supply a name the first one
  // lacked, as when a draft addressed someone by address alone and their reply
  // then arrived with a display name.
  const participants = new Map();
  for (const m of messages) {
    for (const person of [m.from, ...m.to, ...m.cc]) {
      if (!person?.address) continue;
      const known = participants.get(person.address);
      if (!known || (!known.name && person.name)) {
        participants.set(person.address, { name: person.name, address: person.address });
      }
    }
  }

  return Thread.findByIdAndUpdate(
    threadId,
    {
      subject: basis[0].subject,
      // Kept in step with the subject, or a draft whose subject was edited
      // would leave the thread unfindable by the stage 4 subject fallback.
      normalizedSubject: normalizeSubject(basis[0].subject),
      messageCount: basis.length,
      lastMessageAt: last.sentAt,
      snippet: last.snippet,
      folders: [...new Set(messages.map((m) => m.folder))],
      hasUnread: messages.some((m) => !m.isRead),
      isStarred: messages.some((m) => m.isStarred),
      participants: [...participants.values()],
      ...bucketOf(real),
    },
    { new: true },
  );
}
