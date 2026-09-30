import { logger } from '../../config/logger.js';
import { embedMessages } from './embed-messages.js';

const log = logger.child({ worker: 'embeddings' });

// How long the queue waits after the first message arrives before embedding,
// so a burst of writes, such as one message to ten people or a page of
// imported mail, goes to the model as one batch rather than ten.
const GATHER_MS = 250;
// Most messages taken from the queue at a time.
const TAKE = 100;

// Embeds messages in the background, after they have been written. A write
// never waits for this and never fails because of it: if the model cannot be
// reached, the messages keep embeddedAt null, and the backfill finds them
// through the index made for that.
//
// Each process has its own queue. What is still in it when the process stops
// is left for the backfill.
export function createEmbedQueue({ embed = embedMessages, gatherMs = GATHER_MS } = {}) {
  const waiting = new Set();
  let timer = null;
  let running = null;

  async function drain() {
    while (waiting.size > 0) {
      const ids = [...waiting].slice(0, TAKE);
      ids.forEach((id) => waiting.delete(id));
      try {
        await embed(ids);
      } catch (err) {
        log.warn({ err: err.message, code: err.code, messages: ids.length }, 'could not embed messages, the backfill will pick them up');
      }
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    running ??= drain().finally(() => {
      running = null;
      // Added after the last batch was taken but before the queue went idle,
      // when add() saw it still running and set no timer of its own.
      if (waiting.size > 0 && !timer) timer = setTimeout(flush, gatherMs);
    });
    return running;
  }

  return {
    // Adds message ids to embed shortly.
    add(ids) {
      for (const id of ids) waiting.add(String(id));
      if (!timer && !running) timer = setTimeout(flush, gatherMs);
    },
    // Embeds everything waiting now, and resolves once it is done: for a
    // process about to stop, and for tests.
    async flush() {
      await running;
      await flush();
    },
    get size() {
      return waiting.size;
    },
  };
}

const queue = createEmbedQueue();

export const embedLater = (ids) => queue.add(ids);
export const flushEmbeddings = () => queue.flush();
