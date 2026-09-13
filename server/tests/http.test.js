import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { connect, disconnect, clearDb, credentials } from './helpers.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/error.js';
import { REDACT } from '../src/config/logger.js';
import { User } from '../src/models/index.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

describe('validation', () => {
  it('reports every bad field in one response', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'nope', password: 'short', name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
    expect(Object.keys(res.body.fields).sort()).toEqual(['email', 'name', 'password']);
  });

  it('names the fields that are missing', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'a@b.de' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty('password');
    expect(res.body.fields).toHaveProperty('name');
  });

  it('treats a request with no body as invalid rather than crashing', async () => {
    const res = await request(app).post('/api/auth/login');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_body');
  });

  it('stores the value zod produced, not the raw input', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...credentials, name: '  Semab  ' });
    expect(res.status).toBe(201);
    expect(res.body.user.name).toBe('Semab');
  });
});

describe('body parsing', () => {
  it('answers malformed JSON with a 400, not a 500', async () => {
    const res = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{oops');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('entity.parse.failed');
  });

  it('answers a body over the limit with a 413, not a 500', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...credentials, password: 'x'.repeat(3_000_000) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('entity.too.large');
  });
});

describe('error handler', () => {
  it('answers a malformed ObjectId as not found', async () => {
    const mini = express();
    mini.get('/users/:id', async (req, res) => res.json(await User.findById(req.params.id)));
    mini.use(errorHandler);

    const res = await request(mini).get('/users/not-an-objectid');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('answers an unknown route with JSON', async () => {
    const res = await request(app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

describe('origin check', () => {
  const attempt = () => request(app).post('/api/auth/login').send({ email: 'a@b.de', password: 'x'.repeat(12) });

  it('refuses a state-changing request from another site', async () => {
    const res = await attempt().set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('bad_origin');
  });

  it('lets the client origin through', async () => {
    const res = await attempt().set('Origin', env.CLIENT_ORIGIN);
    expect(res.body.code).toBe('bad_credentials');
  });

  it('lets a request with no Origin through, since it carries no browser cookies', async () => {
    const res = await attempt();
    expect(res.body.code).toBe('bad_credentials');
  });

  it('leaves reads from another site to CORS', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', 'https://evil.example');
    expect(res.status).toBe(401);
  });
});

describe('response headers', () => {
  it('sets the helmet headers and does not name the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request logging', () => {
  it('never writes a session token to the log', async () => {
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
    const logged = createApp({ logger: pino({ level: 'info', redact: REDACT }, stream) });

    await request(logged)
      .post('/api/auth/register')
      .set('Cookie', 'sift_access=SECRET_COOKIE_VALUE')
      .set('Authorization', 'Bearer SECRET_BEARER_VALUE')
      .send(credentials);
    await new Promise((resolve) => setImmediate(resolve));

    const output = chunks.join('');
    // Proves something was logged at all, so the assertions below cannot pass
    // on an empty log.
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('SECRET_COOKIE_VALUE');
    expect(output).not.toContain('SECRET_BEARER_VALUE');
    expect(output).not.toMatch(/sift_(access|refresh)=eyJ/);
  });
});
