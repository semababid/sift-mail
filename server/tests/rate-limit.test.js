import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { connect, disconnect } from './helpers.js';

// The limiters switch themselves off under NODE_ENV=test so the other suites
// can log in as often as they need to. This file turns them back on before the
// app is loaded, which is why the import is dynamic and inside the hook.
let app;

beforeAll(async () => {
  process.env.NODE_ENV = 'development';
  const { createApp } = await import('../src/app.js');
  app = createApp();
  await connect();
});

afterAll(disconnect);

describe('rate limits', () => {
  it('throttles the eleventh login attempt inside the window', async () => {
    const attempt = (i) => request(app).post('/api/auth/login').send({ email: `x${i}@b.de`, password: 'whatever-long' });

    for (let i = 0; i < 10; i += 1) {
      expect((await attempt(i)).status).toBe(401);
    }

    const blocked = await attempt(10);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(blocked.headers.ratelimit).toMatch(/limit=10/);
  });

  it('leaves routes outside auth alone', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
