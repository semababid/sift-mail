import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { Message, Thread } from '../src/models/index.js';
import { forgetQuestionVectors, fuseRankings, RRF_K, searchThreads, threadRanks } from '../src/services/search.service.js';
import { fakeAi } from './fake-ai.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);

const anna = new mongoose.Types.ObjectId();
const ben = new mongoose.Types.ObjectId();

let ai;
beforeEach(async () => {
  await clearDb();
  forgetQuestionVectors();
  ai = fakeAi('fake/embedder');
});

// A conversation with one message, stored the way the app stores them.
async function conversation(subject, bodyText, { userId = anna, folder = 'inbox' } = {}) {
  const thread = await Thread.create({ userId, subject, lastMessageAt: new Date(), folders: [folder] });
  const message = await Message.create({
    userId,
    threadId: thread._id,
    from: { address: 'mara@elsewhere.example' },
    subject,
    bodyText,
    snippet: bodyText.slice(0, 40),
    folder,
    sentAt: new Date(),
  });
  return { thread, message };
}

// Stands in for the Atlas vector search: answers the given messages, in that
// order, as its ranking, and records what it was asked.
function fakeVectorSearch(...ranked) {
  const asked = [];
  const search = async (userId, queryVector, options) => {
    asked.push({ userId: String(userId), model: options.model, size: queryVector.length });
    return ranked.map(({ message }, i) => ({ ...message.toObject(), score: 0.9 - i * 0.01 }));
  };
  return Object.assign(search, { asked });
}

const subjects = (results) => results.map((result) => result.thread.subject);

describe('fusing two rankings', () => {
  it('gives a conversation the rank of its best message', () => {
    const t1 = new mongoose.Types.ObjectId();
    const t2 = new mongoose.Types.ObjectId();
    const ranks = threadRanks([{ threadId: t1, _id: 'a' }, { threadId: t1, _id: 'b' }, { threadId: t2, _id: 'c' }]);
    expect([...ranks].map(([id, { rank, hit }]) => [id, rank, hit._id])).toEqual([
      [String(t1), 1, 'a'],
      [String(t2), 2, 'c'],
    ]);
  });

  const ranking = (...ids) => new Map(ids.map((id, i) => [id, { rank: i + 1 }]));

  it('puts what both found above what only one ranked first', () => {
    const fused = fuseRankings({ keyword: ranking('top-keyword', 'both'), vector: ranking('top-vector', 'both') });
    expect(fused.map((entry) => entry.id)).toEqual(['both', 'top-keyword', 'top-vector']);
    expect(fused[0].score).toBeCloseTo(2 / (RRF_K + 2), 12);
    expect(fused[1].score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  const placed = (ranks) => new Map(Object.entries(ranks).map(([id, rank]) => [id, { rank }]));

  it('settles a tie in favour of the conversation one search ranked high', () => {
    // 1/63 + 1/84 and 1/72 + 1/72 are the same number. Ranked third by meaning
    // says more than twelfth twice, even though keyword search liked it less.
    const fused = fuseRankings({ keyword: placed({ spread: 24, steady: 12 }), vector: placed({ spread: 3, steady: 12 }) });
    expect(fused[0].score).toBe(fused[1].score);
    expect(fused.map((entry) => entry.id)).toEqual(['spread', 'steady']);
  });

  it('settles a tie that is even on that as well in favour of keyword search', () => {
    const fused = fuseRankings({ keyword: placed({ a: 3, b: 4 }), vector: placed({ a: 4, b: 3 }) });
    expect(fused.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('hybrid search', () => {
  it('finds by keyword and by meaning together, and ranks what both found first', async () => {
    const both = await conversation('Kaution', 'Die Kaution kommt nächste Woche zurück.');
    const meaningOnly = await conversation('Geld für die Wohnung', 'Die Überweisung ist unterwegs.');
    await conversation('Unpassend', 'Etwas ganz anderes, auch Kaution erwähnt.');

    const { results, mode } = await searchThreads(anna, 'Kaution', {
      limit: 10,
      ai,
      vectorSearch: fakeVectorSearch(meaningOnly, both),
    });
    expect(mode).toBe('hybrid');
    expect(subjects(results)[0]).toBe('Kaution');
    expect(subjects(results)).toContain('Geld für die Wohnung');
    expect(subjects(results)).toContain('Unpassend');
  });

  it('asks the vector search for this mailbox, with the model that embedded the question', async () => {
    await conversation('Kaution', 'Kaution');
    const vectorSearch = fakeVectorSearch();

    await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch });
    expect(vectorSearch.asked).toEqual([{ userId: String(anna), model: 'fake/embedder', size: expect.any(Number) }]);
    expect(ai.calls).toEqual([{ texts: ['Kaution'], purpose: 'query' }]);
  });

  it('never shows a conversation from another mailbox, even if a search let one through', async () => {
    const own = await conversation('Eigene Kaution', 'Kaution');
    const someoneElses = await conversation('Fremde Kaution', 'Kaution', { userId: ben });

    const { results } = await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch(someoneElses, own) });
    expect(subjects(results)).toEqual(['Eigene Kaution']);
  });

  it('shows the message that ranked the conversation higher', async () => {
    const { thread } = await conversation('Wohnung', 'Die Kaution steht im Vertrag.');
    const reply = await Message.create({
      userId: anna,
      threadId: thread._id,
      from: { address: 'mara@elsewhere.example' },
      subject: 'Re: Wohnung',
      bodyText: 'Überwiesen wird am Freitag.',
      snippet: 'Überwiesen wird am Freitag.',
      folder: 'inbox',
      sentAt: new Date(),
    });
    // Keyword search finds the first message at its rank 1; the vector search
    // finds the reply at its rank 1 as well. Equal ranks go to keyword search.
    const { results } = await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch({ message: reply }) });
    expect(results).toHaveLength(1);
    expect(results[0].match.subject).toBe('Wohnung');
  });

  it('returns no more conversations than the limit', async () => {
    const all = [];
    for (let i = 0; i < 6; i += 1) all.push(await conversation(`Kaution ${i}`, 'Kaution'));
    const { results } = await searchThreads(anna, 'Kaution', { limit: 4, ai, vectorSearch: fakeVectorSearch(...all) });
    expect(results).toHaveLength(4);
  });

  it('shows both ranks and scores with debug, and nothing extra without it', async () => {
    const both = await conversation('Kaution', 'Kaution');
    const meaningOnly = await conversation('Geld zurück', 'Überweisung');

    const { results } = await searchThreads(anna, 'Kaution', {
      limit: 10,
      debug: true,
      ai,
      vectorSearch: fakeVectorSearch(meaningOnly, both),
    });
    const byName = Object.fromEntries(results.map((r) => [r.thread.subject, r.debug]));
    expect(byName.Kaution).toEqual({ keyword: { rank: 1, score: expect.any(Number) }, vector: { rank: 2, score: 0.89 } });
    expect(byName['Geld zurück']).toEqual({ keyword: null, vector: { rank: 1, score: 0.9 } });

    const plain = await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch(both) });
    expect(plain.results[0]).not.toHaveProperty('debug');
  });
});

describe('when vector search cannot run', () => {
  it('searches by keyword alone when the model is down, and says so', async () => {
    await conversation('Kaution', 'Kaution');
    ai.state.fail = 'unavailable';

    const answer = await searchThreads(anna, 'Kaution', { limit: 10, debug: true, ai, vectorSearch: fakeVectorSearch() });
    expect(answer).toMatchObject({ mode: 'keyword', vectorUnavailable: 'unavailable' });
    expect(subjects(answer.results)).toEqual(['Kaution']);
  });

  it('searches by keyword alone when the database has no vector search', async () => {
    await conversation('Kaution', 'Kaution');
    const vectorSearch = async () => {
      throw Object.assign(new Error('$vectorSearch is not allowed'), { codeName: 'Location40324' });
    };

    const answer = await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch });
    expect(answer.mode).toBe('keyword');
    expect(subjects(answer.results)).toEqual(['Kaution']);
  });

  it('goes back to hybrid as soon as the model answers again', async () => {
    await conversation('Kaution', 'Kaution');
    ai.state.fail = 'unavailable';
    ai.state.failTimes = 1;

    expect((await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch() })).mode).toBe('keyword');
    expect((await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch() })).mode).toBe('hybrid');
  });
});

describe('one side at a time, for comparing them', () => {
  it('leaves the model out entirely for keyword search', async () => {
    await conversation('Kaution', 'Kaution');
    const vectorSearch = fakeVectorSearch();
    const { mode } = await searchThreads(anna, 'Kaution', { limit: 10, use: 'keyword', ai, vectorSearch });
    expect(mode).toBe('keyword');
    expect(ai.calls).toEqual([]);
    expect(vectorSearch.asked).toEqual([]);
  });

  it('leaves keyword search out for vector search', async () => {
    await conversation('Kaution', 'Kaution');
    const meaningMatch = await conversation('Geld zurück', 'Überweisung');
    const { results, mode } = await searchThreads(anna, 'Kaution', { limit: 10, use: 'vector', ai, vectorSearch: fakeVectorSearch(meaningMatch) });
    expect(mode).toBe('vector');
    expect(subjects(results)).toEqual(['Geld zurück']);
  });
});

describe("the question's vector", () => {
  it('is worked out once for the same words, and again for another model', async () => {
    await conversation('Kaution', 'Kaution');
    await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch() });
    await searchThreads(anna, 'Kaution', { limit: 10, ai, vectorSearch: fakeVectorSearch() });
    expect(ai.calls).toHaveLength(1);

    const other = fakeAi('fake/other');
    await searchThreads(anna, 'Kaution', { limit: 10, ai: other, vectorSearch: fakeVectorSearch() });
    expect(other.calls).toHaveLength(1);
  });

  it('is kept for each user apart, so nobody can time a search to learn what others asked', async () => {
    await searchThreads(anna, 'Kündigung Wohnung', { limit: 10, ai, vectorSearch: fakeVectorSearch() });
    await searchThreads(ben, 'Kündigung Wohnung', { limit: 10, ai, vectorSearch: fakeVectorSearch() });
    expect(ai.calls).toHaveLength(2);
  });

  it('holds 500 questions and forgets the one asked longest ago', async () => {
    const ask = (words) => searchThreads(anna, words, { limit: 1, use: 'vector', ai, vectorSearch: fakeVectorSearch() });
    for (let i = 0; i < 500; i += 1) await ask(`Frage ${i}`);
    // Asking the first one again makes it the most recent, so the next new
    // question pushes out the second instead.
    await ask('Frage 0');
    await ask('Frage 500');
    expect(ai.calls).toHaveLength(501);

    await ask('Frage 0');
    expect(ai.calls).toHaveLength(501);
    await ask('Frage 1');
    expect(ai.calls).toHaveLength(502);
  });

  it('is never written to the database', async () => {
    await conversation('Kaution', 'Kaution');
    const { db } = mongoose.connection;
    const everything = async () => {
      const counts = {};
      for (const { name } of await db.listCollections().toArray()) counts[name] = await db.collection(name).countDocuments();
      return counts;
    };
    const before = await everything();

    await searchThreads(anna, 'eine sehr persönliche Frage', { limit: 10, ai, vectorSearch: fakeVectorSearch() });
    expect(ai.calls).toHaveLength(1);
    expect(await everything()).toEqual(before);
  });
});

describe('GET /api/search', () => {
  it('says which searches took part, and gives the debug detail only when asked', async () => {
    const who = await signIn(app);
    await conversation('Kaution', 'Kaution', { userId: who.user._id });

    const plain = await request(app).get('/api/search').query({ q: 'Kaution' }).set('Cookie', who.cookie);
    expect(plain.status).toBe(200);
    // The test setup points at a model that is not running.
    expect(plain.body.mode).toBe('keyword');
    expect(plain.body.results[0]).not.toHaveProperty('debug');
    expect(plain.body).not.toHaveProperty('vectorUnavailable');

    const debug = await request(app).get('/api/search').query({ q: 'Kaution', debug: '1' }).set('Cookie', who.cookie);
    expect(debug.body.results[0].debug).toEqual({ keyword: { rank: 1, score: expect.any(Number) }, vector: null });
    expect(debug.body.vectorUnavailable).toEqual(expect.any(String));
  });

  it('refuses a debug value it cannot read as yes or no', async () => {
    const who = await signIn(app);
    const res = await request(app).get('/api/search').query({ q: 'Kaution', debug: 'vielleicht' }).set('Cookie', who.cookie);
    expect(res.status).toBe(400);
  });
});
