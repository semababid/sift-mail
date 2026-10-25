// Work done in the background after a write, by id: embedding and triage
// both use it. A write never waits for this and never fails because of it.
// If the work fails, the ids are dropped and logged, and the backfill for
// that kind of work finds them again, since whatever is undone is still
// marked undone in the database.
//
// Each process has its own queue, and what is in it when the process stops
// is left for the backfill.
//
//   work(ids, { signal })  does a batch; `signal` aborts when the queue stops
//   gatherMs               how long to wait after the first id arrives, so a
//                          burst of writes becomes one batch
//   take                   most ids handed to `work` at once
//   log, what              where failures are logged, and what to call them
export function createBackgroundQueue({ work, gatherMs, take, log, what }) {
  const waiting = new Set();
  let timer = null;
  let running = null;
  // Made up front, so a batch already running when stop() comes holds the
  // signal that cancels it.
  const stopping = new AbortController();

  async function drain() {
    while (waiting.size > 0 && !stopping.signal.aborted) {
      const ids = [...waiting].slice(0, take);
      ids.forEach((id) => waiting.delete(id));
      try {
        await work(ids, { signal: stopping.signal });
      } catch (err) {
        if (stopping.signal.aborted) return;
        log.warn({ err: err.message, code: err.code, messages: ids.length }, `could not ${what}, the backfill will pick them up`);
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
      if (waiting.size > 0 && !timer && !stopping.signal.aborted) timer = setTimeout(flush, gatherMs);
    });
    return running;
  }

  return {
    // Adds ids to work on shortly. Ignored once the queue has stopped.
    add(ids) {
      if (stopping.signal.aborted) return;
      for (const id of ids) waiting.add(String(id));
      if (!timer && !running) timer = setTimeout(flush, gatherMs);
    },
    // Does everything waiting now, and resolves once it is done: for a
    // process about to stop when the work is quick, and for tests.
    async flush() {
      await running;
      await flush();
    },
    // Drops what is waiting, cancels the batch in hand, and resolves once it
    // has given up: for a process about to stop when the work is too slow to
    // finish in time.
    async stop() {
      stopping.abort();
      clearTimeout(timer);
      timer = null;
      waiting.clear();
      await running;
    },
    get size() {
      return waiting.size;
    },
  };
}
