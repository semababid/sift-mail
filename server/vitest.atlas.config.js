import { defineConfig } from 'vitest/config';

// The tests that need a real Atlas cluster, which `npm test` leaves out. Run
// with `npm run test:atlas`. They use a database of their own on the cluster in
// MONGO_URI_ATLAS and empty it when they finish.
export default defineConfig({
  test: {
    include: ['tests/atlas/**/*.atlas.js'],
    setupFiles: ['./tests/atlas/setup.js'],
    pool: 'forks',
    testTimeout: 120_000,
    // Building the vector index takes Atlas about half a minute.
    hookTimeout: 360_000,
  },
});
