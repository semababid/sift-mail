import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connectDb } from '../../src/config/db.js';
import { Message, Thread } from '../../src/models/index.js';
import { ensureVectorIndex, vectorSearchMessages } from '../../src/services/vector-search.js';
import { searchThreads } from '../../src/services/search.service.js';
import { fakeAi, vectorFor } from '../fake-ai.js';

// Vector search against a real Atlas cluster, in a database of its own that is
// emptied at the end. Run with: npm run test:atlas --workspace=server
//
// The point of it: a search can only ever return the searcher's own mail.

const MODEL = 'ollama/bge-m3';
const anna = new mongoose.Types.ObjectId();
const ben = new mongoose.Types.ObjectId();
const nobody = new mongoose.Types.ObjectId();
const QUESTION = 'Wann kommt die Kaution zurück?';
const question = vectorFor(QUESTION);

// A vector close to `vector` but not the same: the two are mixed, and the result
// scaled back to length 1.
function near(vector, other, weight = 0.15) {
  const mixed = vector.map((x, i) => x * (1 - weight) + other[i] * weight);
  const norm = Math.sqrt(mixed.reduce((sum, x) => sum + x * x, 0));
  return mixed.map((x) => x / norm);
}

const ids = {};
function message(name, userId, embedding, fields = {}) {
  ids[name] = new mongoose.Types.ObjectId();
  return {
    _id: ids[name],
    userId,
    threadId: new mongoose.Types.ObjectId(),
    from: { address: 'vermieter@elsewhere.example' },
    subject: name,
    folder: 'inbox',
    sentAt: new Date(),
    embedding,
    embeddingModel: MODEL,
    embeddedAt: new Date(),
    ...fields,
  };
}

// Removes every collection in the test database, with its search indexes. The
// app's database user may not drop a whole database, and does not need to.
async function emptyTestDatabase() {
  const { db } = mongoose.connection;
  if (!db.databaseName.endsWith('_test')) throw new Error(`refusing to empty ${db.databaseName}`);
  for (const collection of await db.collections()) await collection.drop();
}

const search = (userId, limit = 100) => vectorSearchMessages(userId, question, { model: MODEL, limit });
const names = (hits) => hits.map((hit) => hit.subject).sort();

// Atlas indexes new documents a few seconds after they are written. Waits until
// a search sees what it should, so a test that expects something to be absent
// cannot pass only because it had not been indexed yet.
async function untilIndexed(userId, expected, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = names(await search(userId));
    if (expected.every((name) => found.includes(name))) return;
    if (Date.now() > deadline) throw new Error(`Atlas never indexed ${expected.join(', ')}; it found ${found.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

beforeAll(async () => {
  await connectDb();
  // Whatever an earlier run that stopped halfway left behind.
  await emptyTestDatabase();
  // The text index too, for the hybrid search at the end.
  await Message.syncIndexes();
  await ensureVectorIndex();

  await Message.insertMany([
    // Ben's message is exactly the question's vector, so it is the nearest
    // thing in the whole collection. Anna's is close, but less close.
    message('ben-kaution', ben, question, { bodyText: 'Die Kaution kommt zurück.' }),
    message('ben-other', ben, vectorFor('Stromrechnung')),
    message('anna-kaution', anna, near(question, vectorFor('Wohnung')), { bodyText: 'Die Kaution kommt zurück.' }),
    message('anna-other', anna, vectorFor('Seminar am Montag')),
    // Anna's, but none of these may ever come back.
    message('anna-draft', anna, question, { isDraft: true, folder: 'drafts' }),
    message('anna-trash', anna, question, { folder: 'trash' }),
    message('anna-spam', anna, question, { folder: 'spam' }),
    message('anna-old-model', anna, question, { embeddingModel: 'ollama/nomic-embed-text' }),
  ]);
  // A conversation for each message, which hybrid search returns.
  await Thread.insertMany(
    (await Message.find({}, { userId: 1, threadId: 1, subject: 1 }).lean()).map((m) => ({
      _id: m.threadId,
      userId: m.userId,
      subject: m.subject,
      lastMessageAt: new Date(),
      folders: ['inbox'],
    })),
  );
  await untilIndexed(anna, ['anna-kaution', 'anna-other']);
  await untilIndexed(ben, ['ben-kaution', 'ben-other']);
});

afterAll(async () => {
  await emptyTestDatabase();
  await mongoose.disconnect();
});

describe('vector search on Atlas', () => {
  it("returns only the searcher's own mail", async () => {
    expect(names(await search(anna))).toEqual(['anna-kaution', 'anna-other']);
    expect(names(await search(ben))).toEqual(['ben-kaution', 'ben-other']);
  });

  it("filters before it picks the nearest, so another user's nearer mail does not crowd out the searcher's", async () => {
    // Ben's copy is the single nearest vector. Filtering after the nearest one
    // was picked would leave Anna with nothing.
    const [best] = await search(anna, 1);
    expect(best.subject).toBe('anna-kaution');
  });

  it('ranks by how close the meaning is, with a score', async () => {
    const hits = await search(anna);
    expect(hits.map((hit) => hit.subject)).toEqual(['anna-kaution', 'anna-other']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('leaves out drafts, trash, spam, and vectors from another model', async () => {
    const found = names(await search(anna));
    for (const name of ['anna-draft', 'anna-trash', 'anna-spam', 'anna-old-model']) expect(found).not.toContain(name);
  });

  it('finds nothing for someone with no mail', async () => {
    expect(await search(nobody)).toEqual([]);
  });

  it('leaves the index alone when it already matches the definition', async () => {
    expect(await ensureVectorIndex()).toMatchObject({ action: 'unchanged', status: 'READY' });
  });
});

describe('hybrid search on Atlas', () => {
  const hybrid = (userId) => searchThreads(userId, QUESTION, { limit: 20, debug: true, ai: fakeAi(MODEL) });

  it("fuses both searches, and still returns only the searcher's own conversations", async () => {
    const { results, mode } = await hybrid(anna);
    expect(mode).toBe('hybrid');
    expect(results.map((r) => r.thread.subject)).toEqual(['anna-kaution', 'anna-other']);
    // Found by both, where the other was found by meaning alone.
    expect(results[0].debug).toEqual({ keyword: { rank: 1, score: expect.any(Number) }, vector: { rank: 1, score: expect.any(Number) } });
    expect(results[1].debug.keyword).toBeNull();
  });

  it('gives someone else their own conversations in turn', async () => {
    const { results } = await hybrid(ben);
    expect(results.map((r) => r.thread.subject)).toEqual(['ben-kaution', 'ben-other']);
  });
});
