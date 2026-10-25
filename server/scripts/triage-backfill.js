import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { getAi } from '../src/services/ai/index.js';
import { countNeedingTriage, runTriageBackfill } from '../src/services/triage/backfill.js';

// Sorts every received message without a bucket into one, for mail written
// before stage 6 and for whatever the background queue did not get to. Safe
// to stop with Ctrl+C and to run again: it carries on with what is left.
//
//   npm run triage:backfill --workspace=server
//   npm run triage:backfill --workspace=server -- --dry-run
//   npm run triage:backfill --workspace=server -- --email semab@sift.example --limit 50

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
  const { users, total } = await countNeedingTriage({ userIds });
  console.log(`${total} received messages across ${users.length} account${users.length === 1 ? '' : 's'} have no bucket yet.`);
  await disconnectDb();
  process.exit(0);
}

// Ctrl+C finishes the chunk in hand. A second Ctrl+C cancels the message the
// model is working on and stops there.
let stopRequested = false;
const cancel = new AbortController();
process.on('SIGINT', () => {
  if (stopRequested) {
    cancel.abort();
    return;
  }
  stopRequested = true;
  process.stdout.write('\nStopping after this chunk. Press Ctrl+C again to stop now.\n');
});

const started = performance.now();
const clock = (seconds) => (seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`);
let total = 0;

function show(progress) {
  const done = progress.classified + progress.failed;
  const seconds = (performance.now() - started) / 1000;
  const each = done > 0 ? seconds / done : 0;
  const left = done > 0 ? clock((total - done) * each) : 'unknown';
  process.stdout.write(`\r  ${done}/${total} done, ${each.toFixed(1)} s a message, about ${left} left   `);
}

console.log(`Sorting with ${ai.chatModel}${opts.limit ? `, at most ${opts.limit} messages` : ''}.`);
try {
  const result = await runTriageBackfill({
    ai,
    userIds,
    limit: opts.limit ? Number(opts.limit) : Infinity,
    shouldStop: () => stopRequested,
    signal: cancel.signal,
    onProgress: (progress) => {
      total ||= progress.total;
      show(progress);
    },
    onRetry: (err, waitMs) => process.stdout.write(`\n  ${err.message}. Trying again in ${waitMs / 1000} s.\n`),
  });

  console.log(`\n\n${result.classified} messages sorted in ${clock((performance.now() - started) / 1000)}.`);
  if (result.failed) console.log(`${result.failed} got no usable answer from the model and are left for the next run.`);
  if (result.stopped) console.log('Stopped early. Run it again to carry on from here.');
} catch (err) {
  const kept = err.totals?.classified ?? 0;
  console.error(`\n\nStopped: ${err.message}`);
  console.error(`${kept} messages were sorted before that, and are kept. Run it again to carry on from here.`);
  process.exitCode = 1;
}
await disconnectDb();
