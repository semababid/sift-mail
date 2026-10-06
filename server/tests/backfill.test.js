import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connect, disconnect, clearDb } from './helpers.js';
import { EmbeddingCache, Message, Thread } from '../src/models/index.js';
import { setAi } from '../src/services/ai/index.js';
import { countNeedingVectors, runBackfill } from '../src/services/embedding/backfill.js';
import { fakeAi } from './fake-ai.js';

beforeAll(connect);
afterAll(async () => {
  setAi(undefined);
  await disconnect();
});

const anna = new mongoose.Types.ObjectId();
const ben = new mongoose.Types.ObjectId();
const T0 = Date.UTC(2026, 4, 1);

let ai;
let waited;
beforeEach(async () => {
  await clearDb();
  ai = fakeAi();
  waited = [];
});

// `count` stored messages for one user, a minute apart unless `sameTime`.
async function stored(count, { userId = anna, sameTime = false, text = (i) => `Nachricht ${i}`, ...fields } = {}) {
  const thread = await Thread.create({ userId, lastMessageAt: new Date(T0) });
  const docs = await Message.insertMany(
    Array.from({ length: count }, (_, i) => ({
      userId,
      threadId: thread._id,
      from: { address: 'mara@elsewhere.example' },
      subject: text(i),
      bodyText: `Inhalt von ${text(i)}`,
      folder: 'inbox',
      sentAt: new Date(sameTime ? T0 : T0 + i * 60_000),
      ...fields,
    })),
  );
  return docs.map((doc) => doc._id);
}

const backfill = (options = {}) =>
  runBackfill({ ai, chunkSize: 10, wait: async (ms) => waited.push(ms), ...options });
const missing = () => Message.countDocuments({ embeddedAt: null, isDraft: false });

describe('the backfill', () => {
  it('gives every message without a vector one, newest first, a chunk at a time', async () => {
    await stored(25);

    const result = await backfill();
    expect(result).toMatchObject({ embedded: 25, asked: 25, failed: 0, total: 25, stopped: null });
    expect(await missing()).toBe(0);
    // Chunks of 10, and the newest message first.
    expect(ai.calls.map((call) => call.texts.length)).toEqual([10, 10, 5]);
    // The newest ten messages make up the first chunk.
    const firstChunk = ai.calls[0].texts.map((text) => Number(text.match(/^Nachricht (\d+)/)[1])).sort((a, b) => a - b);
    expect(firstChunk).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it('leaves drafts and mail still waiting for its text for later', async () => {
    await stored(2);
    await stored(1, { isDraft: true, folder: 'drafts', text: () => 'Entwurf' });
    await stored(1, { bodyStatus: 'pending', text: () => 'Kommt noch' });

    // Not counted as waiting either, so the progress shown is right.
    expect((await countNeedingVectors()).total).toBe(2);
    expect(await backfill()).toMatchObject({ embedded: 2, total: 2 });
    expect(ai.calls.flatMap((call) => call.texts).some((t) => /Entwurf|Kommt noch/.test(t))).toBe(false);
  });

  it('carries on where it stopped, and never asks for the same text twice', async () => {
    await stored(25);
    let chunks = 0;

    const first = await backfill({ shouldStop: () => chunks >= 1, onProgress: () => (chunks += 1) });
    expect(first).toMatchObject({ embedded: 10, stopped: 'asked' });
    expect(await missing()).toBe(15);

    const second = await backfill();
    expect(second).toMatchObject({ embedded: 15, total: 15, stopped: null });
    expect(ai.calls.flatMap((call) => call.texts)).toHaveLength(25);
  });

  it('walks messages that share a second without missing or repeating any', async () => {
    await stored(23, { sameTime: true });

    const result = await backfill({ chunkSize: 4 });
    expect(result.embedded).toBe(23);
    const asked = ai.calls.flatMap((call) => call.texts);
    expect(new Set(asked).size).toBe(23);
    expect(await missing()).toBe(0);
  });

  it('asks the model once for text that repeats, and answers the rest from the cache', async () => {
    await stored(12, { text: (i) => (i % 2 ? 'Newsletter' : `Persönlich ${i}`) });

    const result = await backfill();
    expect(result).toMatchObject({ embedded: 12, asked: 7 });
    expect(await EmbeddingCache.countDocuments()).toBe(7);
  });

  it('embeds again what has a vector from another model, and leaves the current model’s alone', async () => {
    await stored(3);
    await backfill({ ai: fakeAi('fake/old') });
    await stored(2, { text: (i) => `Neu ${i}` });
    await runBackfill({ ai, chunkSize: 10 });
    ai.calls.length = 0;

    const current = await Message.find({ subject: /^Neu/ }).select('embeddedAt').lean();
    const result = await backfill();
    expect(result).toMatchObject({ remarked: 0, embedded: 0 });

    const changed = await backfill({ ai: fakeAi('fake/newer') });
    expect(changed).toMatchObject({ remarked: 5, embedded: 5 });
    expect((await Message.find().lean()).every((m) => m.embeddingModel === 'fake/newer')).toBe(true);
    expect(current).toHaveLength(2);
  });

  it('stops after the number of messages it was given', async () => {
    await stored(25);
    const result = await backfill({ limit: 13 });
    expect(result).toMatchObject({ embedded: 13, total: 13, stopped: 'limit' });
    expect(ai.calls.map((call) => call.texts.length)).toEqual([10, 3]);
  });

  it('only does the accounts it was given', async () => {
    await stored(3, { userId: anna });
    await stored(4, { userId: ben, text: (i) => `Ben ${i}` });

    expect((await backfill({ userIds: [ben] })).embedded).toBe(4);
    expect(await Message.countDocuments({ userId: anna, embeddedAt: null })).toBe(3);
  });

  it('counts what is waiting, per account or for everyone', async () => {
    await stored(3, { userId: anna });
    await stored(4, { userId: ben, text: (i) => `Ben ${i}` });
    expect((await countNeedingVectors()).total).toBe(7);
    expect((await countNeedingVectors({ userIds: [anna] })).total).toBe(3);
  });
});

describe('when the model fails', () => {
  it('tries again after a pause when the model is briefly unreachable, then carries on', async () => {
    await stored(15);
    ai.state.fail = 'unavailable';
    ai.state.failTimes = 2;

    const result = await backfill();
    expect(result.embedded).toBe(15);
    expect(waited).toEqual([2_000, 4_000]);
  });

  it('stops when the model stays unreachable, keeping what it did, and finishes on the next run', async () => {
    await stored(25);
    let chunks = 0;
    const flaky = fakeAi();
    const original = flaky.embed;
    flaky.embed = async (...args) => {
      if (chunks >= 1) flaky.state.fail = 'unavailable';
      return original(...args);
    };

    const err = await backfill({ ai: flaky, onProgress: () => (chunks += 1) }).catch((error) => error);
    expect(err).toMatchObject({ code: 'unavailable', totals: { embedded: 10 } });
    expect(waited).toEqual([2_000, 4_000, 8_000]);
    expect(await missing()).toBe(15);

    expect((await backfill()).embedded).toBe(15);
  });

  it('stops at once, without retrying, when the model is not set up', async () => {
    await stored(5);
    ai.state.fail = 'model_missing';

    await expect(backfill()).rejects.toMatchObject({ code: 'model_missing' });
    expect(waited).toEqual([]);
    expect(ai.calls).toHaveLength(1);
  });

  it('skips a chunk the model answers with something unusable, and carries on', async () => {
    await stored(25);
    ai.state.fail = 'bad_response';
    ai.state.failTimes = 1;

    const result = await backfill();
    expect(result).toMatchObject({ embedded: 15, failed: 10 });
    // Left for the next run, which picks them up.
    expect(await missing()).toBe(10);
    expect((await backfill()).embedded).toBe(10);
  });
});
