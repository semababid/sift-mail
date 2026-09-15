import { describe, it, expect } from 'vitest';
import { shouldRetry } from './query-client.js';

const failed = (status) => ({ response: { status } });

describe('query retries', () => {
  it.each([400, 401, 403, 404, 409, 429])('never retries a %i', (status) => {
    expect(shouldRetry(0, failed(status))).toBe(false);
  });

  it('retries a server error twice, then stops', () => {
    expect([0, 1, 2].map((count) => shouldRetry(count, failed(500)))).toEqual([true, true, false]);
  });

  it('retries a request that never got a response', () => {
    expect(shouldRetry(0, new Error('Network Error'))).toBe(true);
  });
});
