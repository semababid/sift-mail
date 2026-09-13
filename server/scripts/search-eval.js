import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { searchThreads } from '../src/services/search.service.js';
import { SEARCH_QUERIES } from './search-queries.js';

// Runs the question set against a seeded mailbox and reports, for each kind of
// question, how often the right conversation came first, how often it made the
// top k, and the mean reciprocal rank. Run `npm run seed` first.
const { values: opts } = parseArgs({
  options: {
    email: { type: 'string', default: 'semab@sift.example' },
    k: { type: 'string', default: '5' },
  },
});
const K = Number(opts.k);
const DEPTH = 20;

await connectDb();

const user = await User.findOne({ email: opts.email.toLowerCase() });
if (!user) {
  console.error(`No account for ${opts.email}. Run npm run seed first.`);
  await disconnectDb();
  process.exit(1);
}

const rows = [];
for (const q of SEARCH_QUERIES) {
  const results = await searchThreads(user._id, q.query, { limit: DEPTH });
  // 0 means the right conversation was not in the top DEPTH at all.
  const rank = results.findIndex((r) => r.thread.subject === q.expect) + 1;
  rows.push({ ...q, rank, returned: results.length });
}

const rankLabel = (rank) => (rank === 0 ? `not in top ${DEPTH}` : `#${rank}`);
console.log(`\nkeyword search, ${rows.length} questions, account ${user.email}\n`);
for (const row of rows) {
  console.log(`  ${row.kind.padEnd(11)} ${rankLabel(row.rank).padEnd(15)} ${row.query}`);
}

const summarise = (subset) => {
  const n = subset.length;
  const hit1 = subset.filter((r) => r.rank === 1).length;
  const hitK = subset.filter((r) => r.rank >= 1 && r.rank <= K).length;
  const mrr = subset.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n;
  return `${String(hit1).padStart(2)}/${n} first   ${String(hitK).padStart(2)}/${n} in top ${K}   MRR ${mrr.toFixed(2)}`;
};

console.log('');
for (const kind of [...new Set(rows.map((r) => r.kind))]) {
  console.log(`  ${kind.padEnd(11)} ${summarise(rows.filter((r) => r.kind === kind))}`);
}
console.log(`  ${'all'.padEnd(11)} ${summarise(rows)}\n`);

await disconnectDb();
