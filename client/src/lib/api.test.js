import { describe, it, expect, vi } from 'vitest';
import { createApi } from './api.js';

const REFRESH = '/api/auth/refresh';

// A stand-in for the network. `respond` picks each answer from the URL and how
// many times that URL has been requested so far.
function fakeServer(respond) {
  const calls = [];
  const seen = new Map();

  const adapter = async (config) => {
    calls.push(config.url);
    const attempt = (seen.get(config.url) ?? 0) + 1;
    seen.set(config.url, attempt);

    const { status, data = {}, delay = 0 } = respond(config.url, attempt);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

    const response = { status, data, headers: {}, config, statusText: String(status) };
    if (status >= 400) {
      throw Object.assign(new Error(`request failed with ${status}`), { config, response, isAxiosError: true });
    }
    return response;
  };

  return { adapter, calls, count: (url) => calls.filter((call) => call === url).length };
}

describe('api client', () => {
  it('sends cookies with every request', async () => {
    const server = fakeServer(() => ({ status: 200 }));
    const res = await createApi({ adapter: server.adapter }).get('/api/threads');
    expect(res.config.withCredentials).toBe(true);
  });

  it('refreshes the session after a 401 and retries the request once', async () => {
    const server = fakeServer((url, attempt) => {
      if (url === REFRESH) return { status: 200 };
      return attempt === 1 ? { status: 401, data: { code: 'bad_access_token' } } : { status: 200, data: { threads: [] } };
    });

    const res = await createApi({ adapter: server.adapter }).get('/api/threads');
    expect(res.data).toEqual({ threads: [] });
    expect(server.calls).toEqual(['/api/threads', REFRESH, '/api/threads']);
  });

  it('shares one refresh between requests that fail at the same time', async () => {
    const server = fakeServer((url, attempt) => {
      // The refresh is slow enough that all three requests are waiting on it.
      if (url === REFRESH) return { status: 200, delay: 20 };
      return attempt === 1 ? { status: 401 } : { status: 200, data: { url } };
    });
    const api = createApi({ adapter: server.adapter });

    const results = await Promise.all(['/api/a', '/api/b', '/api/c'].map((url) => api.get(url)));
    expect(results.map((r) => r.data.url)).toEqual(['/api/a', '/api/b', '/api/c']);
    expect(server.count(REFRESH)).toBe(1);
  });

  it('reports an expired session and gives up when the refresh is refused', async () => {
    const onSessionExpired = vi.fn();
    const server = fakeServer((url) =>
      url === REFRESH ? { status: 401, data: { code: 'refresh_reuse' } } : { status: 401 },
    );

    await expect(createApi({ adapter: server.adapter, onSessionExpired }).get('/api/threads')).rejects.toMatchObject({
      response: { status: 401 },
      config: { url: '/api/threads' },
    });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual(['/api/threads', REFRESH]);
  });

  it('retries without logging out when another tab refreshed first', async () => {
    const onSessionExpired = vi.fn();
    const server = fakeServer((url, attempt) => {
      if (url === REFRESH) return { status: 401, data: { code: 'stale_refresh_token' } };
      return attempt === 1 ? { status: 401 } : { status: 200, data: { ok: true } };
    });

    const res = await createApi({ adapter: server.adapter, onSessionExpired }).get('/api/threads');
    expect(res.data).toEqual({ ok: true });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it.each(['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/logout'])(
    'takes a 401 from %s as the answer, without refreshing',
    async (url) => {
      const onSessionExpired = vi.fn();
      const server = fakeServer(() => ({ status: 401, data: { code: 'bad_credentials' } }));

      await expect(createApi({ adapter: server.adapter, onSessionExpired }).post(url)).rejects.toMatchObject({
        response: { status: 401 },
      });
      expect(server.calls).toEqual([url]);
      expect(onSessionExpired).not.toHaveBeenCalled();
    },
  );

  it('does not refresh again when the retried request is refused too', async () => {
    const server = fakeServer((url) => {
      if (url === REFRESH) return { status: 200 };
      // A safety stop, so a client that loops fails this test instead of hanging it.
      return server.calls.length > 20 ? { status: 599 } : { status: 401 };
    });

    await expect(createApi({ adapter: server.adapter }).get('/api/x')).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(server.calls).toEqual(['/api/x', REFRESH, '/api/x']);
  });

  it('passes other errors straight through', async () => {
    const server = fakeServer(() => ({ status: 500 }));
    await expect(createApi({ adapter: server.adapter }).get('/api/threads')).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(server.calls).toEqual(['/api/threads']);
  });
});
