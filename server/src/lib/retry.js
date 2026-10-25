// Runs `work`, and when it fails with an error marked retryable, as a model
// that is briefly unreachable, waits and runs it again, once per entry in
// `waits`. Anything else, and the last failure, is thrown.
export async function withRetries(work, { waits, wait, onRetry }) {
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

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
