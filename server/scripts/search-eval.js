import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { searchThreads } from '../src/services/search.service.js';
import { SEARCH_QUERIES } from './search-queries.js';

// Runs the question set against a seeded mailbox and reports, for each kind of
// question, how often the right conversation came first, how often it made the
// top k, and the mean reciprocal rank. Keyword search, vector search and the
// two fused are measured side by side, through the same search the app uses.
// Run `npm run seed` first; vector search needs Atlas and the model running.
const { values: opts } = parseArgs({
  options: {
    email: { type: 'string', default: 'semab@sift.example' },
    k: { type: 'string', default: '5' },
  },
});
const K = Number(opts.k);
const DEPTH = 20;
const MODES = ['keyword', 'vector', 'hybrid'];

await connectDb();

const user = await User.findOne({ email: opts.email.toLowerCase() });
if (!user) {
  console.error(`No account for ${opts.email}. Run npm run seed first.`);
  await disconnectDb();
  process.exit(1);
}

const ranks = Object.fromEntries(MODES.map((mode) => [mode, []]));
for (const q of SEARCH_QUERIES) {
  for (const mode of MODES) {
    const { results, mode: ran } = await searchThreads(user._id, q.query, { limit: DEPTH, use: mode });
    if (mode !== 'keyword' && ran === 'keyword') {
      console.error('Vector search is not running: check that MONGO_URI points at Atlas and that Ollama is up.');
      await disconnectDb();
      process.exit(1);
    }
    // 0 means the right conversation was not in the top DEPTH at all.
    ranks[mode].push(results.findIndex((r) => r.thread.subject === q.expect) + 1);
  }
}

const cell = (rank) => (rank === 0 ? '-' : `#${rank}`).padStart(8);
console.log(`\n${SEARCH_QUERIES.length} questions, account ${user.email}\n`);
console.log(`  ${'kind'.padEnd(11)}${MODES.map((m) => m.padStart(8)).join('')}  question`);
SEARCH_QUERIES.forEach((q, i) => {
  console.log(`  ${q.kind.padEnd(11)}${MODES.map((m) => cell(ranks[m][i])).join('')}  ${q.query}`);
});
console.log(`  (- means not in the top ${DEPTH})`);

const summarise = (subset) => {
  const n = subset.length;
  const hit1 = subset.filter((r) => r === 1).length;
  const hitK = subset.filter((r) => r >= 1 && r <= K).length;
  const mrr = subset.reduce((sum, r) => sum + (r ? 1 / r : 0), 0) / n;
  return `${String(hit1).padStart(2)}/${n} first   ${String(hitK).padStart(2)}/${n} in top ${K}   MRR ${mrr.toFixed(2)}`;
};

for (const kind of [...new Set(SEARCH_QUERIES.map((q) => q.kind)), 'all']) {
  const at = SEARCH_QUERIES.map((q, i) => (kind === 'all' || q.kind === kind ? i : -1)).filter((i) => i >= 0);
  console.log(`\n  ${kind}`);
  for (const mode of MODES) console.log(`    ${mode.padEnd(8)} ${summarise(at.map((i) => ranks[mode][i]))}`);
}
console.log('');

await disconnectDb();
