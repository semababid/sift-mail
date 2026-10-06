import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { getAi } from '../src/services/ai/index.js';
import { countNeedingVectors, runBackfill } from '../src/services/embedding/backfill.js';

// Gives every message without a vector one, for mail written before stage 5,
// or after the embedding model changed. Safe to stop with Ctrl+C and to run
// again: it carries on with whatever is still missing.
//
//   npm run embed:backfill --workspace=server
//   npm run embed:backfill --workspace=server -- --dry-run
//   npm run embed:backfill --workspace=server -- --email semab@sift.example --limit 50

const { values: opts } = parseArgs({
  options: {
    email: { type: 'string' },
    limit: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

await connectDb();
const ai = getAi();

let userIds;
if (opts.email) {
  const user = await User.findOne({ email: opts.email.toLowerCase() });
  if (!user) {
    console.error(`No account for ${opts.email}.`);
    await disconnectDb();
    process.exit(1);
  }
  userIds = [user._id];
}

if (opts['dry-run']) {
  const { users, total } = await countNeedingVectors({ userIds });
  const accounts = `${users.length} account${users.length === 1 ? '' : 's'}`;
  console.log(`${total} messages across ${accounts} need a vector from ${ai.embeddingModel}.`);
  console.log('Messages with a vector from another model are counted once a real run marks them.');
  await disconnectDb();
  process.exit(0);
}

// Ctrl+C finishes the chunk in hand, then stops. A second Ctrl+C stops at once.
let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  process.stdout.write('\nStopping after this chunk. Press Ctrl+C again to stop now.\n');
});

const started = performance.now();
const clock = (seconds) => (seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`);
let total = 0;

function show(progress) {
  const done = progress.embedded + progress.failed;
  const seconds = (performance.now() - started) / 1000;
  const rate = done / seconds;
  const left = rate > 0 ? clock((total - done) / rate) : 'unknown';
  process.stdout.write(`\r  ${done}/${total} done, ${Math.round(rate)} a second, about ${left} left   `);
}

console.log(`Embedding with ${ai.embeddingModel}${opts.limit ? `, at most ${opts.limit} messages` : ''}.`);
try {
  const result = await runBackfill({
    ai,
    userIds,
    limit: opts.limit ? Number(opts.limit) : Infinity,
    shouldStop: () => stopRequested,
    onProgress: (progress) => {
      total ||= progress.total;
      show(progress);
    },
    onRetry: (err, waitMs) => process.stdout.write(`\n  ${err.message}. Trying again in ${waitMs / 1000} s.\n`),
  });
  total = result.total;

  console.log(`\n\n${result.embedded} messages embedded in ${clock((performance.now() - started) / 1000)}.`);
  console.log(`The model was asked for ${result.asked} texts; the rest repeated text it had already embedded.`);
  if (result.remarked) console.log(`${result.remarked} had a vector from another model and were embedded again.`);
  if (result.failed) console.log(`${result.failed} could not be embedded this time and are left for the next run.`);
  if (result.stopped) console.log('Stopped early. Run it again to carry on from here.');
} catch (err) {
  const kept = err.totals?.embedded ?? 0;
  console.error(`\n\nStopped: ${err.message}`);
  console.error(`${kept} messages were embedded before that, and are kept. Run it again to carry on from here.`);
  process.exitCode = 1;
}
await disconnectDb();
