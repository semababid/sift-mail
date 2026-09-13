import { Message, Thread } from '../models/index.js';
import { HIDDEN_FROM_LABELS } from '../lib/constants.js';

// How many matching messages get ranked before they are grouped into
// conversations. Search returns the best few conversations, not every match:
// relevance ranking stops meaning much a few pages down, and scoring an
// unbounded number of hits for a common word is the expensive part.
const MESSAGE_POOL = 200;

// Matching messages for one user, best first. It stays at the message level
// on purpose: stage 5 fuses this ranking with the vector search, which also
// ranks messages. Mongo's $text matches any of the words by default, and
// quoted phrases and -negated words work as Mongo defines them.
export async function keywordSearchMessages(userId, query, { limit = MESSAGE_POOL } = {}) {
  return Message.find(
    // Trash and spam stay out, as in Gmail. Drafts, archive and sent stay in.
    { userId, $text: { $search: query }, folder: { $nin: HIDDEN_FROM_LABELS } },
    { score: { $meta: 'textScore' }, threadId: 1, subject: 1, snippet: 1, from: 1, sentAt: 1, folder: 1 },
  )
    .sort({ score: { $meta: 'textScore' }, _id: -1 })
    .limit(limit)
    .lean();
}

export async function searchThreads(userId, query, { limit }) {
  const hits = await keywordSearchMessages(userId, query);

  // A conversation ranks by its single best message. Adding up every match
  // would let a long thread outrank a short one that matches better, just by
  // having more replies. Hits arrive best first, so the first one seen for a
  // thread is its best.
  const best = new Map();
  for (const hit of hits) {
    const key = String(hit.threadId);
    if (!best.has(key)) best.set(key, hit);
  }
  const top = [...best.values()].slice(0, limit);

  const threads = await Thread.find({ _id: { $in: top.map((h) => h.threadId) }, userId });
  const byId = new Map(threads.map((t) => [String(t._id), t]));

  return top
    .filter((hit) => byId.has(String(hit.threadId)))
    .map((hit) => ({
      thread: byId.get(String(hit.threadId)).toJSON(),
      match: {
        messageId: String(hit._id),
        subject: hit.subject,
        snippet: hit.snippet,
        from: hit.from,
        sentAt: hit.sentAt,
        folder: hit.folder,
        // Kept in the response so stage 5 can show the keyword score beside
        // the vector score while tuning the fusion.
        score: Math.round(hit.score * 1000) / 1000,
      },
    }));
}
