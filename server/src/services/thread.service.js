import mongoose from 'mongoose';
import { Thread, Message } from '../models/index.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { HttpError } from '../lib/errors.js';

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
