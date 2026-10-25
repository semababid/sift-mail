import { logger } from '../../config/logger.js';
import { createBackgroundQueue } from '../../lib/background-queue.js';
import { embedMessages } from './embed-messages.js';

// How long the queue waits after the first message arrives before embedding,
// so a burst of writes, such as one message to ten people or a page of
// imported mail, goes to the model as one batch rather than ten.
const GATHER_MS = 250;
// Most messages taken from the queue at a time.
const TAKE = 100;

// Embeds messages in the background, after they have been written. If the
// model cannot be reached, the messages keep embeddedAt null, and the
// backfill finds them through the index made for that.
export function createEmbedQueue({ embed = embedMessages, gatherMs = GATHER_MS } = {}) {
  return createBackgroundQueue({
    work: (ids) => embed(ids),
    gatherMs,
    take: TAKE,
    log: logger.child({ worker: 'embeddings' }),
    what: 'embed messages',
  });
}

const queue = createEmbedQueue();

export const embedLater = (ids) => queue.add(ids);
export const flushEmbeddings = () => queue.flush();
