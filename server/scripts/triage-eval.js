import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { INTENTS } from '../src/lib/constants.js';
import { getAi } from '../src/services/ai/index.js';
import { classifyMessage } from '../src/services/triage/classify.js';
import { accuracy, confusion, evaluate, loadEvalItems, shuffleKey } from '../src/services/triage/evaluation.js';

// Scores triage against the messages labelled by hand with eval:label:
// accuracy per bucket zero-shot, then again once the user has corrected
// some of the model's mistakes, which the model is then shown as examples
// (stage 6.4). Nothing is written to the database.
//
//   npm run eval:triage --workspace=server
//   npm run eval:triage --workspace=server -- --steps 10,25,50 --json results.json
//   npm run eval:triage --workspace=server -- --limit 20
//
// The model reads every message at least once, a few seconds each, so 200
// take around ten minutes, and the steps add a call for each message a
// correction is near.

const { values: opts } = parseArgs({
  options: {
    email: { type: 'string' },
    steps: { type: 'string', default: '10,25,50' },
    limit: { type: 'string' },
    json: { type: 'string' },
  },
});
const steps = opts.steps
  .split(',')
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

await connectDb();
const ai = getAi();
const users = opts.email ? await User.find({ email: opts.email.toLowerCase() }) : await User.find().limit(2);
if (users.length !== 1) {
  console.error(opts.email ? `No account for ${opts.email}.` : 'There is more than one account. Say which with --email.');
  await disconnectDb();
  process.exit(1);
}
const [user] = users;

let items = await loadEvalItems(user._id, { ai });
if (opts.limit) items = items.sort((a, b) => (shuffleKey(a._id) < shuffleKey(b._id) ? -1 : 1)).slice(0, Number(opts.limit));
if (items.length === 0) {
  console.error('Nothing is labelled yet. Label some mail first: npm run eval:label --workspace=server');
  await disconnectDb();
  process.exit(1);
}

const started = performance.now();
let calls = 0;
// A message the model gives no usable bucket for twice counts as wrong. Any
// other failure, as the model not running, stops the run.
async function classify(item, examples) {
  calls += 1;
  try {
    return (await classifyMessage(item.message, { user, examples, ai })).label;
  } catch (err) {
    if (err.code === 'bad_response') return null;
    throw err;
  }
}
const progress = ({ step, done, total }) =>
  process.stderr.write(`\r  ${step === 0 ? 'zero-shot' : `with ${step} corrections`}: ${done}/${total}, ${calls} asked   `);

let result;
try {
  result = await evaluate(items, { classify, steps, onProgress: progress });
} catch (err) {
  console.error(`\nThe model could not be reached, so nothing was scored: ${err.message}`);
  await disconnectDb();
  process.exit(1);
}
const minutes = (performance.now() - started) / 60_000;
process.stderr.write('\n\n');

const real = items.filter((item) => item.real).length;
console.log(
  `Triage on ${items.length} messages labelled by hand (${items.length - real} seeded, ${real} real), ` +
    `${ai.chatModel}, ${calls} calls in ${minutes.toFixed(0)} min\n`,
);

const pct = ({ right, of }) => (of === 0 ? '-' : `${Math.round((100 * right) / of)}%`);
const columns = [
  { title: 'zero-shot', predicted: result.zeroShot },
  ...result.steps.map((s) => ({
    title: s.corrections < s.n ? `${s.corrections} corr. (all)` : `${s.n} corr.`,
    predicted: s.predicted,
    withExamples: s.withExamples,
  })),
];
const subsets = [
  ...INTENTS.map((bucket) => [bucket, (item) => item.truth === bucket]),
  ['all', () => true],
  ['  seeded mail', (item) => !item.real],
  ['  real mail', (item) => item.real],
];
const cell = (text) => String(text).padStart(16);
console.log(''.padEnd(24) + columns.map((c) => cell(c.title)).join(''));
for (const [name, keep] of subsets) {
  const subset = items.filter(keep);
  const row = columns.map((c) => cell(pct(accuracy(subset, c.predicted).all)));
  console.log(`${name} (${subset.length})`.padEnd(24) + row.join(''));
}
console.log('sorted with examples'.padEnd(24) + columns.map((c) => cell(c.withExamples ?? 0)).join(''));

console.log('\nZero-shot, by the bucket given by hand (rows) and the one the model gave (columns):');
const matrix = confusion(items, result.zeroShot);
const heads = [...INTENTS, 'none'];
console.log(''.padEnd(18) + heads.map((h) => h.padStart(16)).join(''));
for (const truth of INTENTS) console.log(truth.padEnd(18) + heads.map((h) => String(matrix[truth][h]).padStart(16)).join(''));

if (opts.json) {
  const asObject = (map) => Object.fromEntries([...map].map(([id, label]) => [id, label]));
  fs.writeFileSync(
    opts.json,
    JSON.stringify(
      {
        model: ai.chatModel,
        embeddingModel: ai.embeddingModel,
        messages: items.map((item) => ({ id: String(item._id), truth: item.truth, real: item.real })),
        zeroShot: asObject(result.zeroShot),
        steps: result.steps.map((s) => ({ ...s, predicted: asObject(s.predicted) })),
      },
      null,
      2,
    ),
  );
  console.log(`\nEvery answer is in ${opts.json}.`);
}

await disconnectDb();
