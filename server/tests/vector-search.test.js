import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connect, disconnect } from './helpers.js';
import { EMBEDDING_DIMS } from '../src/lib/constants.js';
import { ensureVectorIndex, vectorIndexDefinition, vectorSearchStage, VECTOR_INDEX } from '../src/services/vector-search.js';

// The search itself only runs on Atlas, and is tested there by
// tests/atlas/vector-search.atlas.js (npm run test:atlas). These check what can
// be checked without it: that every search carries its filters.

beforeAll(connect);
afterAll(disconnect);

const userId = new mongoose.Types.ObjectId();
const queryVector = Array(EMBEDDING_DIMS).fill(0.01);

describe('the search stage', () => {
  it('always narrows to one mailbox, the question’s model, and mail outside drafts, trash and spam', () => {
    const { $vectorSearch: search } = vectorSearchStage({ userId, queryVector, model: 'ollama/bge-m3', limit: 20 });
    expect(search).toMatchObject({ index: VECTOR_INDEX, path: 'embedding', limit: 20, numCandidates: 300 });
    expect(search.filter).toEqual({
      userId: { $eq: userId },
      embeddingModel: { $eq: 'ollama/bge-m3' },
      isDraft: { $eq: false },
      folder: { $nin: ['trash', 'spam'] },
    });
  });

  it('takes the user id as a string too, and filters on it as an ObjectId', () => {
    const { $vectorSearch: search } = vectorSearchStage({ userId: String(userId), queryVector, model: 'm' });
    expect(search.filter.userId.$eq).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(search.filter.userId.$eq)).toBe(String(userId));
  });

  it.each([
    ['no user', { queryVector, model: 'm' }],
    ['no model', { userId, queryVector }],
    ['a vector of the wrong size', { userId, queryVector: [0.1, 0.2], model: 'm' }],
  ])('refuses to search with %s', (_case, input) => {
    expect(() => vectorSearchStage(input)).toThrow(TypeError);
  });

  it('never asks Atlas for more candidates than it allows', () => {
    const { $vectorSearch: search } = vectorSearchStage({ userId, queryVector, model: 'm', limit: 5000 });
    expect(search.numCandidates).toBe(10_000);
  });
});

describe('the index definition', () => {
  it('matches the vector size, and can filter on everything a search filters on', () => {
    const { fields } = vectorIndexDefinition();
    expect(fields.find((field) => field.type === 'vector')).toEqual({
      type: 'vector',
      path: 'embedding',
      numDimensions: EMBEDDING_DIMS,
      similarity: 'dotProduct',
    });
    const filterable = fields.filter((field) => field.type === 'filter').map((field) => field.path);
    const { filter } = vectorSearchStage({ userId, queryVector, model: 'm' }).$vectorSearch;
    expect(filterable.sort()).toEqual(Object.keys(filter).sort());
  });

  it('is skipped, not failed, on a Mongo without Atlas Search', async () => {
    const result = await ensureVectorIndex({ timeoutMs: 1000 });
    expect(result.action).toBe('skipped');
  });
});
