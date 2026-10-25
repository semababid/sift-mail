import { logger } from '../../config/logger.js';
import { createBackgroundQueue } from '../../lib/background-queue.js';
import { triageMessages } from './triage-messages.js';

// A moment to gather a burst of new mail, as the embedding queue does. The
// model takes each message on its own, so this only saves timers.
const GATHER_MS = 250;
// A few seconds a message, so a batch of ten is half a minute of work.
const TAKE = 10;

// Sorts received mail into buckets in the background, after it has been
// written. Anything it does not get to keeps intent.classifiedAt null, and the
// triage backfill finds it there.
export function createTriageQueue({ triage = triageMessages, gatherMs = GATHER_MS } = {}) {
  return createBackgroundQueue({
    work: (ids, { signal }) => triage(ids, { signal }),
    gatherMs,
    take: TAKE,
    log: logger.child({ worker: 'triage' }),
    what: 'sort messages into buckets',
  });
}

const queue = createTriageQueue();

export const triageLater = (ids) => queue.add(ids);
export const flushTriage = () => queue.flush();
// Too slow to finish inside a shutdown deadline, so a stopping process drops
// what is waiting and leaves it for the backfill.
export const stopTriage = () => queue.stop();
