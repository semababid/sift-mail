import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Message, Thread, User } from '../src/models/index.js';
import { HIDDEN_FROM_LABELS } from '../src/lib/constants.js';
import { embeddingText } from '../src/lib/embedding-text.js';
import { createOllamaProvider } from '../src/services/ai/ollama.js';
import { searchThreads } from '../src/services/search.service.js';
import { SEARCH_QUERIES } from './search-queries.js';

// Compares embedding models on the question set from stage 2.6, side by side
// with keyword search, over the same mailbox. Everything stays in memory:
// nothing is written to the database, so it can be run before choosing the
// model whose vectors Sift will store.
//
//   npm run eval:embeddings --workspace=server
//   npm run eval:embeddings --workspace=server -- --models nomic-embed-text,bge-m3
//
// A conversation ranks by its best-matching message, as keyword search does.
const { values: opts } = parseArgs({
  options: {
    email: { type: 'string', default: 'semab@sift.example' },
    models: { type: 'string', default: 'nomic-embed-text,bge-m3' },
    k: { type: 'string', default: '5' },
  },
});
const K = Number(opts.k);
const DEPTH = 20;
const BATCH = 32;
const models = opts.models.split(',').map((model) => model.trim()).filter(Boolean);

// The vector size a model makes, as Ollama describes it.
async function dimsOf(model) {
  const res = await fetch(new URL('/api/show', env.OLLAMA_HOST), { method: 'POST', body: JSON.stringify({ model }) });
  if (!res.ok) throw new Error(`Ollama does not have ${model}. Get it with: ollama pull ${model}`);
  const info = (await res.json()).model_info ?? {};
  const key = Object.keys(info).find((name) => name.endsWith('.embedding_length'));
  if (!key) throw new Error(`${model} is not an embedding model`);
  return info[key];
}

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
};

await connectDb();
const user = await User.findOne({ email: opts.email.toLowerCase() });
if (!user) {
  console.error(`No account for ${opts.email}. Run npm run seed first.`);
  await disconnectDb();
  process.exit(1);
}

// What search looks through: sent and received mail, not drafts, not trash or spam.
const messages = await Message.find({ userId: user._id, isDraft: false, folder: { $nin: HIDDEN_FROM_LABELS } })
  .select('threadId subject bodyText')
  .lean();
const subjectOf = new Map(
  (await Thread.find({ userId: user._id }).select('subject').lean()).map((thread) => [String(thread._id), thread.subject]),
);
const texts = messages.map(embeddingText);
console.log(`\n${messages.length} messages in ${new Set(messages.map((m) => String(m.threadId))).size} conversations, ${SEARCH_QUERIES.length} questions\n`);

// Rank 0 means not in the top DEPTH.
const rankOf = (orderedSubjects, expect) => {
  const at = orderedSubjects.slice(0, DEPTH).indexOf(expect);
  return at + 1;
};

const methods = [];

// Keyword search, measured again here so every method sees the same mailbox.
const keywordRanks = [];
for (const q of SEARCH_QUERIES) {
  const { results } = await searchThreads(user._id, q.query, { limit: DEPTH, use: 'keyword' });
  keywordRanks.push(rankOf(results.map((r) => r.thread.subject), q.expect));
}
methods.push({ name: 'keyword', ranks: keywordRanks });

for (const model of models) {
  const dims = await dimsOf(model);
  const ai = createOllamaProvider({ host: env.OLLAMA_HOST, embeddingModel: model, chatModel: env.CHAT_MODEL, dims });

  // Loads the model before timing starts, so the rate is the working rate.
  await ai.embed(['warm up']);
  const started = performance.now();
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    vectors.push(...(await ai.embed(texts.slice(i, i + BATCH))));
    process.stdout.write(`\r  ${model}: ${vectors.length}/${texts.length} embedded`);
  }
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(`\r  ${model}: ${texts.length} messages in ${seconds.toFixed(0)} s, ${Math.round(texts.length / seconds)} a second, ${dims} numbers each\n`);

  const queryVectors = await ai.embed(SEARCH_QUERIES.map((q) => q.query), { purpose: 'query' });
  const ranks = queryVectors.map((query, index) => {
    const best = new Map();
    messages.forEach((message, i) => {
      const key = String(message.threadId);
      const score = dot(query, vectors[i]);
      if (!best.has(key) || score > best.get(key)) best.set(key, score);
    });
    const ordered = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => subjectOf.get(id));
    return rankOf(ordered, SEARCH_QUERIES[index].expect);
  });
  methods.push({ name: model, ranks, seconds, dims });
}

// One row per question, one column per method.
const cell = (rank) => (rank === 0 ? '-' : `#${rank}`).padStart(5);
console.log(`\n  ${'kind'.padEnd(11)}${methods.map((m) => m.name.slice(0, 16).padStart(18)).join('')}  question`);
SEARCH_QUERIES.forEach((q, i) => {
  console.log(`  ${q.kind.padEnd(11)}${methods.map((m) => cell(m.ranks[i]).padStart(18)).join('')}  ${q.query}`);
});
console.log(`  (- means not in the top ${DEPTH})`);

const summary = (ranks) => {
  const n = ranks.length;
  const first = ranks.filter((r) => r === 1).length;
  const topK = ranks.filter((r) => r >= 1 && r <= K).length;
  const mrr = ranks.reduce((sum, r) => sum + (r ? 1 / r : 0), 0) / n;
  return `${first}/${n} first, ${topK}/${n} top ${K}, MRR ${mrr.toFixed(2)}`;
};
for (const kind of [...new Set(SEARCH_QUERIES.map((q) => q.kind)), 'all']) {
  const indexes = SEARCH_QUERIES.map((q, i) => (kind === 'all' || q.kind === kind ? i : -1)).filter((i) => i >= 0);
  console.log(`\n  ${kind}`);
  for (const method of methods) {
    console.log(`    ${method.name.padEnd(18)} ${summary(indexes.map((i) => method.ranks[i]))}`);
  }
}
console.log('');
await disconnectDb();
