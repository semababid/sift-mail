import { Message } from '../../models/index.js';
import { AiError, getAi } from '../ai/index.js';
import { embedMessages } from './embed-messages.js';

// Messages read from the database at a time. embedMessages splits each chunk
// into calls of 32 for the model.
export const CHUNK = 256;
// Waits before trying the model again, after it was unreachable.
export const RETRY_WAITS_MS = [2_000, 4_000, 8_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What needs a vector: sent and received mail without one, leaving out drafts
// and imported mail still waiting for its text.
const needsVector = (userId) => ({ userId, embeddedAt: null, isDraft: false, bodyStatus: { $ne: 'pending' } });

// Vectors from another model cannot be compared with the current model's, so
// those messages are marked to be embedded again. Their old vectors stay
// until the new ones replace them, which means that for a while the database
// holds vectors from two models: search must only compare a question with
// vectors from the model that embedded the question.
const fromOtherModels = ({ model, userIds }) => ({
  isDraft: false,
  embeddedAt: { $ne: null },
  embeddingModel: { $ne: model },
  ...(userIds ? { userId: { $in: userIds } } : {}),
});

export async function markOtherModels({ model, userIds }) {
  const res = await Message.updateMany(fromOtherModels({ model, userIds }), { $set: { embeddedAt: null } });
  return res.modifiedCount;
}

// How many messages are waiting, per user, for a dry run and for progress.
export async function countNeedingVectors({ userIds } = {}) {
  const users = userIds ?? (await Message.distinct('userId', { embeddedAt: null, isDraft: false }));
  let total = 0;
  for (const userId of users) total += await Message.countDocuments(needsVector(userId));
  return { users, total };
}

async function withRetries(work, { waits, wait, onRetry }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      if (!err.retryable || attempt >= waits.length) throw err;
      onRetry?.(err, waits[attempt]);
      await wait(waits[attempt]);
    }
  }
}

// Embeds every message that needs a vector, user by user, newest first, a
// chunk at a time.
//
// Stopping and starting again needs no saved position: a message that has its
// vector carries embeddedAt and is not in the next run's query at all. Within
// a run, the walk goes by date and _id, so a chunk that failed is not read
// again and again.
//
// A model that is unreachable is tried three more times, waiting longer each
// time, and then the run stops with what it has done kept. A configuration problem, such
// as a model that is not installed, stops it at once, since every chunk would
// fail the same way. A chunk the model answers with something unusable is
// skipped, counted, and left for the next run.
export async function runBackfill({
  ai = getAi(),
  userIds,
  limit = Infinity,
  chunkSize = CHUNK,
  waits = RETRY_WAITS_MS,
  wait = sleep,
  shouldStop = () => false,
  onProgress = () => {},
  onRetry,
} = {}) {
  const totals = { embedded: 0, asked: 0, failed: 0, remarked: 0, stopped: null };
  if (!ai.embeddingModel) throw new AiError('not_configured', `the ${ai.name} provider has no embedding model to backfill with`);

  // Marking undoes every vector from another model at once. If the model
  // named now cannot run, a typo in EMBEDDING_MODEL for one, the run would
  // stop straight after, and the whole mailbox would be left to embed again
  // once the setting was put back. So the model is asked first.
  if (await Message.exists(fromOtherModels({ model: ai.embeddingModel, userIds }))) {
    try {
      await withRetries(() => ai.embed(['Sift'], { purpose: 'document' }), { waits, wait, onRetry });
    } catch (err) {
      throw Object.assign(err, { totals });
    }
  }
  totals.remarked = await markOtherModels({ model: ai.embeddingModel, userIds });
  const { users, total } = await countNeedingVectors({ userIds });
  totals.total = Math.min(total, limit);

  for (const userId of users) {
    let after = null;
    for (;;) {
      if (shouldStop()) return { ...totals, stopped: 'asked' };
      const room = limit - totals.embedded - totals.failed;
      if (room <= 0) return { ...totals, stopped: 'limit' };

      const filter = needsVector(userId);
      if (after) {
        filter.$or = [{ sentAt: { $lt: after.sentAt } }, { sentAt: after.sentAt, _id: { $lt: after._id } }];
      }
      const chunk = await Message.find(filter)
        .sort({ sentAt: -1, _id: -1 })
        .limit(Math.min(chunkSize, room))
        .select('_id sentAt')
        .lean();
      if (chunk.length === 0) break;
      after = chunk.at(-1);

      try {
        const result = await withRetries(() => embedMessages(chunk.map((m) => m._id), { ai }), { waits, wait, onRetry });
        totals.embedded += result.embedded;
        totals.asked += result.asked;
      } catch (err) {
        if (err.code !== 'bad_response') throw Object.assign(err, { totals });
        totals.failed += chunk.length;
      }
      onProgress({ ...totals });
    }
  }
  return totals;
}
