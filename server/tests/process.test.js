import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dirname, '..');

// Every key the schema reads, set explicitly, so a child passes or fails the
// same way whether or not the machine has a .env file.
const childEnv = (overrides = {}) => ({
  PATH: process.env.PATH,
  NODE_ENV: 'test',
  PORT: '4000',
  LOG_LEVEL: 'silent',
  CLIENT_ORIGIN: 'http://localhost:5173',
  MONGO_URI: process.env.MONGO_URI,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  ...overrides,
});

const loadConfig = (overrides) =>
  spawnSync(process.execPath, ['-e', "import('./src/config/env.js')"], {
    cwd: serverDir,
    env: childEnv(overrides),
    encoding: 'utf8',
  });

describe('environment validation', () => {
  it('accepts a complete configuration', () => {
    const run = loadConfig();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('refuses a missing required key by name', () => {
    // Empty rather than deleted: dotenv would fill a deleted key from .env.
    const run = loadConfig({ MONGO_URI: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/MONGO_URI/);
  });

  it('refuses equal access and refresh secrets', () => {
    const same = 'x'.repeat(40);
    const run = loadConfig({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/JWT_REFRESH_SECRET: must differ/);
  });

  it('refuses a TTL that jsonwebtoken would not understand', () => {
    const run = loadConfig({ ACCESS_TOKEN_TTL: '15 minutes' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ACCESS_TOKEN_TTL/);
  });
});

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The spawned server binds every interface, IPv6 included, so it is reached
// over ::1. Asking 127.0.0.1 can land on another program that holds the same
// port on IPv4 loopback alone, which macOS allows alongside the IPv6 bind.
async function waitUntilHealthy(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://[::1]:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('server never became healthy');
}

describe('graceful shutdown', () => {
  it('exits cleanly on SIGTERM while a keep-alive connection is held open', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: serverDir,
      env: childEnv({ PORT: String(port) }),
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));

    try {
      await waitUntilHealthy(port);

      const socket = net.connect(port, '::1');
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
      await new Promise((resolve) => socket.once('data', resolve));

      const start = Date.now();
      child.kill('SIGTERM');
      const code = await exited;
      socket.destroy();

      expect(code).toBe(0);
      // The hard deadline is eight seconds. An idle keep-alive socket used to
      // hold close() open that long; it should now be dropped straight away.
      expect(Date.now() - start).toBeLessThan(3_000);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
