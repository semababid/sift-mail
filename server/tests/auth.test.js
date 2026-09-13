import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { connect, disconnect, clearDb, cookieJar, credentials } from './helpers.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { User, RefreshToken } from '../src/models/index.js';
import { login } from '../src/services/auth.service.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

async function register() {
  const jar = cookieJar();
  const res = jar.capture(await request(app).post('/api/auth/register').send(credentials));
  return { res, jar };
}

const refresh = (cookie) => request(app).post('/api/auth/refresh').set('Cookie', cookie);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('register', () => {
  it('returns the user and starts a session', async () => {
    const { res, jar } = await register();

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(credentials.email);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    expect(jar.has('sift_access')).toBe(true);
    expect(jar.has('sift_refresh')).toBe(true);
  });

  it('sets httpOnly cookies, with the refresh cookie scoped to the auth routes', async () => {
    const { res } = await register();
    const [access, refreshCookie] = ['sift_access', 'sift_refresh'].map((name) =>
      res.headers['set-cookie'].find((c) => c.startsWith(`${name}=`)),
    );

    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Lax/);
    expect(access).toMatch(/Path=\/;/);
    expect(refreshCookie).toMatch(/HttpOnly/);
    expect(refreshCookie).toMatch(/Path=\/api\/auth/);
  });

  it('refuses an email that is already registered', async () => {
    await register();
    const again = await request(app).post('/api/auth/register').send(credentials);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('email_taken');
  });

  it('gives the loser of a simultaneous registration the same answer', async () => {
    const [a, b] = await Promise.all([
      request(app).post('/api/auth/register').send(credentials),
      request(app).post('/api/auth/register').send(credentials),
    ]);
    const results = [a, b].map((r) => `${r.status}:${r.body.code ?? ''}`).sort();
    expect(results).toEqual(['201:', '409:email_taken']);
  });
});

describe('login', () => {
  it('answers an unknown address and a wrong password identically', async () => {
    await register();
    const unknown = await request(app).post('/api/auth/login').send({ ...credentials, email: 'ghost@nowhere.de' });
    const wrong = await request(app).post('/api/auth/login').send({ ...credentials, password: 'wrong-password' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('does the same hashing work for an address that does not exist', async () => {
    await register();

    // Timed at the service rather than over HTTP, where request overhead would
    // swamp the difference being measured.
    const time = async (email, password) => {
      const start = performance.now();
      await login({ email, password }).catch(() => {});
      return performance.now() - start;
    };
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    const unknown = [];
    const wrong = [];
    for (let i = 0; i < 7; i += 1) {
      unknown.push(await time('ghost@nowhere.de', 'correct-horse'));
      wrong.push(await time(credentials.email, 'wrong-password'));
    }

    // Without the decoy hash, an unknown address costs one indexed lookup and
    // comes back many times faster than a real argon2 verify. Half is loose
    // enough to survive a noisy machine and still catch the decoy going missing.
    expect(median(unknown)).toBeGreaterThan(median(wrong) * 0.5);
  });

  it('logout clears both cookies and ends the session on the server', async () => {
    const { jar } = await register();
    const before = jar.header();

    const out = await request(app).post('/api/auth/logout').set('Cookie', before);
    expect(out.status).toBe(204);
    const cleared = out.headers['set-cookie'].join(';');
    expect(cleared).toMatch(/sift_access=;/);
    expect(cleared).toMatch(/sift_refresh=;/);

    // A copy of the cookie taken before logout must not bring the session back.
    expect((await refresh(before)).status).toBe(401);
  });
});

describe('access tokens', () => {
  let user;
  let jar;

  beforeEach(async () => {
    ({ jar } = await register());
    user = await User.findOne({ email: credentials.email });
  });

  const meWith = (token) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

  it('serves /me from the session cookie', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', jar.header());
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe(credentials.name);
  });

  it('refuses /me with no credentials', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('accepts a genuine access token as a bearer', async () => {
    const token = jwt.sign({ sub: user.id, typ: 'access' }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    expect((await meWith(token)).status).toBe(200);
  });

  it('refuses a refresh token presented as an access token', async () => {
    expect((await meWith(jar.get('sift_refresh'))).status).toBe(401);
  });

  it('refuses the right secret with the wrong typ', async () => {
    const token = jwt.sign({ sub: user.id, typ: 'refresh' }, env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
    expect((await meWith(token)).status).toBe(401);
  });

  it('refuses an unsigned alg=none token', async () => {
    const token = jwt.sign({ sub: user.id, typ: 'access' }, '', { algorithm: 'none', expiresIn: '1h' });
    expect((await meWith(token)).status).toBe(401);
  });

  it('refuses a token that is not a JWT at all', async () => {
    const res = await meWith('not.a.real.token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('bad_access_token');
  });
});

describe('refresh rotation', () => {
  it('hands out a new refresh token on every refresh', async () => {
    const { jar } = await register();
    const before = jar.get('sift_refresh');
    jar.capture(await refresh(jar.header()));
    expect(jar.get('sift_refresh')).not.toBe(before);
  });

  it('lets exactly one of two simultaneous refreshes win, without logging the user out', async () => {
    const { jar } = await register();
    const shared = jar.header();

    const [a, b] = await Promise.all([refresh(shared), refresh(shared)]);
    const winner = a.status === 200 ? a : b;
    const loser = winner === a ? b : a;

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(loser.body.code).toBe('stale_refresh_token');
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBeGreaterThan(0);

    const winnerJar = cookieJar();
    winnerJar.capture(winner);
    expect((await refresh(winnerJar.header())).status).toBe(200);
  });

  it('answers a replay inside the grace window as a race, not theft', async () => {
    const { jar } = await register();
    const first = jar.header();
    expect((await refresh(first)).status).toBe(200);

    const replay = await refresh(first);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('stale_refresh_token');
    // The client already holds the newer cookie, so this answer must not clear it.
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(2);
  });

  it('treats an old replay as theft and ends every session in the family', async () => {
    const { jar } = await register();
    const first = jar.header();
    const firstRaw = jar.get('sift_refresh');

    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    await RefreshToken.updateOne({ tokenHash: sha256(firstRaw) }, { usedAt: new Date(Date.now() - 60_000) });

    const replay = await refresh(first);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('refresh_reuse');
    expect(replay.headers['set-cookie'].join(';')).toMatch(/sift_refresh=;/);
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(0);

    // The token the rotation handed out went down with the family.
    const rotatedJar = cookieJar();
    rotatedJar.capture(rotated);
    expect((await refresh(rotatedJar.header())).status).toBe(401);
  });
});
