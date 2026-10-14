import mongoose from 'mongoose';
import { Message } from '../models/index.js';
import { EMBEDDING_DIMS, HIDDEN_FROM_LABELS } from '../lib/constants.js';

// The Atlas vector index over message embeddings, and the one way Sift
// searches it.
//
// Vector search only runs on Atlas. Mongo itself, including the in-memory one
// the tests use, has no $vectorSearch, so ensureVectorIndex skips it there.

export const VECTOR_INDEX = 'message_vectors';

// Dot product as the similarity, which is the cosine for vectors of length 1,
// and the provider contract makes every vector that. The filter fields are the
// ones a search may narrow on inside the index. Filtering there, before the
// nearest neighbours are picked, keeps another user's mail out of the
// candidates altogether. Filtering afterwards would let it take places among
// them, and the searcher's own mail would lose those places.
export const vectorIndexDefinition = () => ({
  fields: [
    { type: 'vector', path: 'embedding', numDimensions: EMBEDDING_DIMS, similarity: 'dotProduct' },
    { type: 'filter', path: 'userId' },
    { type: 'filter', path: 'embeddingModel' },
    { type: 'filter', path: 'folder' },
    { type: 'filter', path: 'isDraft' },
  ],
});

// How many messages one search returns, and how many candidates the index
// weighs to find them. Atlas suggests ten to twenty times as many candidates
// as results.
export const VECTOR_LIMIT = 100;
const CANDIDATES_PER_RESULT = 15;

// The search stage. Every filter a search needs is set here and cannot be left
// out by a caller:
//   userId          one mailbox, always; there is no way to search without it
//   embeddingModel  only vectors from the model that embedded the question,
//                   since vectors from two models cannot be compared
//   isDraft, folder no drafts, nothing in trash or spam, as keyword search
export function vectorSearchStage({ userId, queryVector, model, limit = VECTOR_LIMIT }) {
  if (!userId) throw new TypeError('a vector search needs the userId of the mailbox it searches');
  if (!model) throw new TypeError('a vector search needs the model that embedded the question');
  if (!Array.isArray(queryVector) || queryVector.length !== EMBEDDING_DIMS) {
    throw new TypeError(`a vector search needs a query vector of ${EMBEDDING_DIMS} numbers`);
  }
  return {
    $vectorSearch: {
      index: VECTOR_INDEX,
      path: 'embedding',
      queryVector,
      limit,
      numCandidates: Math.min(limit * CANDIDATES_PER_RESULT, 10_000),
      filter: {
        userId: { $eq: new mongoose.Types.ObjectId(String(userId)) },
        embeddingModel: { $eq: model },
        isDraft: { $eq: false },
        folder: { $nin: HIDDEN_FROM_LABELS },
      },
    },
  };
}

// Messages from one mailbox nearest a question, best first, with their score.
// The same shape keyword search returns its hits in, so stage 5.5 can merge
// the two rankings.
export async function vectorSearchMessages(userId, queryVector, { model, limit = VECTOR_LIMIT } = {}) {
  return Message.aggregate([
    vectorSearchStage({ userId, queryVector, model, limit }),
    {
      $project: {
        threadId: 1,
        subject: 1,
        snippet: 1,
        from: 1,
        sentAt: 1,
        folder: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);
}

const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Creates the vector index, or brings it in line with the definition above,
// and waits until Atlas reports it can be searched. Answers what it did:
// "created", "updated", "unchanged", or "skipped" where the server is not
// Atlas. A new index takes Atlas around half a minute to build.
export async function ensureVectorIndex({ collection = Message.collection, timeoutMs = 300_000, pollMs = 3_000 } = {}) {
  let existing;
  try {
    [existing] = await collection.listSearchIndexes(VECTOR_INDEX).toArray();
  } catch (err) {
    // Mongo without Atlas Search answers these commands with an error rather
    // than an empty list.
    return { action: 'skipped', reason: err.message };
  }

  const definition = vectorIndexDefinition();
  let action = 'unchanged';
  if (!existing) {
    await collection.createSearchIndex({ name: VECTOR_INDEX, type: 'vectorSearch', definition });
    action = 'created';
  } else if (differs(existing.latestDefinition, definition)) {
    await collection.updateSearchIndex(VECTOR_INDEX, definition);
    action = 'updated';
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [index] = await collection.listSearchIndexes(VECTOR_INDEX).toArray();
    // An update keeps the old version queryable while the new one builds, so
    // waiting is for the status to settle, not only for queryable.
    if (index?.queryable && index.status === 'READY') return { action, status: index.status };
    if (index?.status === 'FAILED') throw new Error(`the vector index failed to build: ${JSON.stringify(index)}`);
    if (Date.now() > deadline) throw new Error(`the vector index was not ready after ${timeoutMs / 1000} s`);
    await sleep(pollMs);
  }
}
