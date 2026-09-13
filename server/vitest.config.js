import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/setup/mongo.js'],
    setupFiles: ['./tests/setup/loopback.js', './tests/setup/env.js'],
    // Separate processes rather than threads. Several suites spawn the server
    // or the seeder as child processes, and each file needs its own copy of
    // the env module parsed from its own process.env.
    pool: 'forks',
    testTimeout: 30_000,
    // The first run downloads a mongod binary, which can take a while.
    hookTimeout: 180_000,
  },
});
