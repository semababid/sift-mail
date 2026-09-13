import { Thread, Message } from '../models/index.js';

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
export async function refreshThread(threadId) {
  const messages = await Message.find({ threadId })
    .select('from to cc subject snippet folder isRead isStarred isDraft sentAt')
    .sort({ sentAt: 1, _id: 1 })
    .lean();

  if (messages.length === 0) {
    await Thread.deleteOne({ _id: threadId });
    return null;
  }

  const real = messages.filter((m) => !m.isDraft);
  const basis = real.length > 0 ? real : messages;
  const last = basis.at(-1);

  const participants = new Map();
  for (const m of messages) {
    for (const person of [m.from, ...m.to, ...m.cc]) {
      if (person?.address && !participants.has(person.address)) {
        participants.set(person.address, { name: person.name, address: person.address });
      }
    }
  }

  return Thread.findByIdAndUpdate(
    threadId,
    {
      subject: basis[0].subject,
      messageCount: basis.length,
      lastMessageAt: last.sentAt,
      snippet: last.snippet,
      folders: [...new Set(messages.map((m) => m.folder))],
      hasUnread: messages.some((m) => !m.isRead),
      isStarred: messages.some((m) => m.isStarred),
      participants: [...participants.values()],
    },
    { new: true },
  );
}
