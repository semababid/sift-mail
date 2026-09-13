import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import request from 'supertest';

const listening = (server, ...args) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => resolve(server.address()));
  });

// Guards tests/setup/loopback.js, which keeps supertest from being answered by
// another program listening on the same port on 127.0.0.1.
describe('supertest connections', () => {
  it('go to IPv6 loopback when the server binds the wildcard', async () => {
    const pending = request((req, res) => res.end('ok')).get('/');
    expect(pending.url).toMatch(/^http:\/\/\[::1\]:\d+\/$/);
    expect((await pending).text).toBe('ok');
  });

  it('reach the app even when another program holds the same port on 127.0.0.1', async () => {
    const holder = spawn(
      process.execPath,
      [
        '-e',
        "const s = require('http').createServer((q, r) => { r.writeHead(418); r.end('other program') })" +
          ".listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port)))",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const port = Number(String(await new Promise((resolve) => holder.stdout.once('data', resolve))));
    const app = http.createServer((req, res) => res.end('app under test'));

    try {
      try {
        await listening(app, port);
      } catch (err) {
        // Linux refuses the overlapping bind outright, so the collision this
        // guards against cannot happen there at all.
        expect(err.code).toBe('EADDRINUSE');
        return;
      }
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toBe('app under test');
    } finally {
      if (app.listening) app.close();
      holder.kill();
    }
  });
});
