import mongoose from 'mongoose';
import { Thread, Message } from '../models/index.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { HttpError } from '../lib/errors.js';
import { refreshThread } from './thread-summary.js';

export async function listThreads(userId, { folder, limit, cursor }) {
  const filter = { userId, folders: folder };

  if (cursor) {
    const { t, id } = decodeCursor(cursor);
    // Everything strictly after the last row of the previous page in sort
    // order: older threads, or the same timestamp with a smaller _id.
    filter.$or = [
      { lastMessageAt: { $lt: t } },
      { lastMessageAt: t, _id: { $lt: new mongoose.Types.ObjectId(id) } },
    ];
  }

  // One row more than the page, so the response can say whether another page
  // exists without a second count query.
  const rows = await Thread.find(filter)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    threads: page,
    nextCursor: hasMore ? encodeCursor(page.at(-1), 'lastMessageAt') : null,
  };
}

export async function getThread(userId, threadId) {
  // Scoped by user in the query itself. Someone else's thread gets the same
  // 404 as one that does not exist, so ids cannot be probed for.
  const thread = await Thread.findOne({ _id: threadId, userId });
  if (!thread) throw new HttpError(404, 'thread not found', 'not_found');

  const messages = await Message.find({ threadId: thread._id, userId }).sort({ sentAt: 1 });
  return { thread, messages };
}

// The newest message in each thread. Starring or marking a conversation unread
// acts on its latest message, as Gmail does: that is enough to put the star or
// the unread dot on the thread, without flagging every reply in it.
async function newestPerThread(userId, threadIds, { allowDrafts }) {
  const rows = await Message.aggregate([
    { $match: { userId, threadId: { $in: threadIds }, ...(allowDrafts ? {} : { isDraft: false }) } },
    // Real messages sort ahead of drafts, so a draft only wins in a thread that
    // has nothing else in it.
    { $sort: { threadId: 1, isDraft: 1, sentAt: -1, _id: -1 } },
    { $group: { _id: '$threadId', messageId: { $first: '$_id' } } },
  ]);
  return rows.map((row) => row.messageId);
}

export async function applyThreadAction(userId, ids, action) {
  const requested = [...new Set(ids)];

  // Ownership is settled before anything is written. Someone else's thread and
  // an id that does not exist are both simply absent from what comes back, so a
  // selection cannot be used to find out which ids are real.
  const owned = await Thread.find({ _id: { $in: requested }, userId }).select('_id');
  const threadIds = owned.map((t) => t._id);
  if (threadIds.length === 0) return [];

  const inThreads = { userId, threadId: { $in: threadIds } };

  switch (action) {
    case 'markRead':
      await Message.updateMany(inThreads, { $set: { isRead: true } });
      break;
    case 'markUnread':
      await Message.updateMany(
        { _id: { $in: await newestPerThread(userId, threadIds, { allowDrafts: false }) } },
        { $set: { isRead: false } },
      );
      break;
    case 'star':
      await Message.updateMany(
        { _id: { $in: await newestPerThread(userId, threadIds, { allowDrafts: true }) } },
        { $set: { isStarred: true } },
      );
      break;
    case 'unstar':
      // Every message, not just the newest. A star set on an older reply would
      // otherwise keep the whole thread starred after the user took it off.
      await Message.updateMany(inThreads, { $set: { isStarred: false } });
      break;
    case 'archive':
      // Only what is in the inbox. Sent mail stays under sent, and archiving
      // should never be a way to pull something back out of trash.
      await Message.updateMany({ ...inThreads, folder: 'inbox' }, { $set: { folder: 'archive' } });
      break;
    case 'moveToInbox':
      await Message.updateMany({ ...inThreads, folder: 'archive' }, { $set: { folder: 'inbox' } });
      break;
    case 'trash':
      // Drafts stay put so a half-written reply is not lost with the thread.
      // Messages already in trash are skipped: trashing twice would otherwise
      // record "trash" as where they came from, and restore would leave them there.
      await Message.updateMany({ ...inThreads, isDraft: false, folder: { $ne: 'trash' } }, [
        { $set: { trashedFrom: '$folder', folder: 'trash' } },
      ]);
      break;
    case 'restore':
      await Message.updateMany({ ...inThreads, folder: 'trash' }, [
        { $set: { folder: { $ifNull: ['$trashedFrom', 'inbox'] }, trashedFrom: null } },
      ]);
      break;
    default:
      throw new Error(`unknown thread action: ${action}`);
  }

  const refreshed = await Promise.all(threadIds.map((id) => refreshThread(id)));

  // Back in the order they were asked for, which is the order the client is
  // showing them in.
  const byId = new Map(refreshed.filter(Boolean).map((t) => [String(t._id), t]));
  return requested.map((id) => byId.get(String(id))).filter(Boolean);
}
