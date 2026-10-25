import { Message } from '../../models/index.js';
import { sleep, withRetries } from '../../lib/retry.js';
import { getAi } from '../ai/index.js';
import { needsTriage, triageMessages } from './triage-messages.js';

// Messages read from the database at a time. The model takes a few seconds
// each, so a chunk is about a minute of work, and stopping waits for at most
// one message.
export const CHUNK = 20;
export const RETRY_WAITS_MS = [2_000, 4_000, 8_000];

export async function countNeedingTriage({ userIds } = {}) {
  const filter = { ...needsTriage(), ...(userIds ? { userId: { $in: userIds } } : {}) };
  const [total, users] = await Promise.all([Message.countDocuments(filter), Message.distinct('userId', filter)]);
  return { users, total };
}

// Sorts every received message that has no bucket yet, user by user, newest
// first, a chunk at a time. It works the way the vector backfill does:
// stopping and starting again needs no saved position, because what has a
// bucket is not in the next run's query; a model that is briefly unreachable
// is waited for, three times, before the run stops; a model that is not set
// up stops it at once. A message the model answers with nothing usable is
// counted and left for the next run.
//
// `shouldStop` is asked between chunks, and `signal` cancels the message in
// hand, for a second Ctrl+C.
export async function runTriageBackfill({
  ai = getAi(),
  userIds,
  limit = Infinity,
  chunkSize = CHUNK,
  waits = RETRY_WAITS_MS,
  wait = sleep,
  shouldStop = () => false,
  signal,
  onProgress = () => {},
  onRetry,
} = {}) {
  const totals = { classified: 0, failed: 0, stopped: null };
  // Messages the model could not sort in this run, so a retried chunk does
  // not ask about them, or count them, twice.
  const failedIds = new Set();
  const count = ({ classified, failedIds: failedNow }) => {
    totals.classified += classified;
    for (const id of failedNow) failedIds.add(id);
    totals.failed = failedIds.size;
  };
  const { users, total } = await countNeedingTriage({ userIds });
  totals.total = Math.min(total, limit);

  for (const userId of users) {
    let after = null;
    for (;;) {
      if (shouldStop() || signal?.aborted) return { ...totals, stopped: 'asked' };
      const room = limit - totals.classified - totals.failed;
      if (room <= 0) return { ...totals, stopped: 'limit' };

      const filter = { userId, ...needsTriage() };
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

      // A retry only redoes what is still without a bucket, and what was done
      // before the failure is counted, since it is saved.
      const attempt = async () => {
        const ids = chunk.map((m) => m._id).filter((id) => !failedIds.has(String(id)));
        try {
          count(await triageMessages(ids, { ai, signal }));
        } catch (err) {
          if (err.partial) count(err.partial);
          throw err;
        }
      };
      try {
        await withRetries(attempt, { waits, wait, onRetry });
      } catch (err) {
        if (signal?.aborted) return { ...totals, stopped: 'asked' };
        throw Object.assign(err, { totals });
      }
      onProgress({ ...totals });
    }
  }
  return totals;
}
