import crypto from 'node:crypto';
import { EmbeddingCache, Message } from '../../models/index.js';
import { embeddingText } from '../../lib/embedding-text.js';
import { getAi } from '../ai/index.js';

// The most texts sent to the model in one call.
export const EMBED_BATCH = 32;

const hashOf = (text) => crypto.createHash('sha256').update(`document\n${text}`).digest('hex');

// Gives each of these messages a vector from the current embedding model,
// unless it already has one from that model. Answers how many were given one
// and how many texts the model was actually asked for, which the cache keeps
// well below the first.
//
// Left alone, and picked up again later:
//   drafts, whose text changes with every keystroke, until they are sent
//   imported mail whose body has not arrived yet
//
// A message with no text at all is marked as done without a vector. There is
// nothing for a vector search to find in it, and leaving it unmarked would
// have the backfill ask about it on every run.
export async function embedMessages(ids, { ai = getAi() } = {}) {
  const model = ai.embeddingModel;
  const messages = await Message.find({
    _id: { $in: ids },
    isDraft: false,
    bodyStatus: { $ne: 'pending' },
    $or: [{ embeddedAt: null }, { embeddingModel: { $ne: model } }],
  })
    .select('subject bodyText')
    .lean();
  if (messages.length === 0) return { embedded: 0, asked: 0 };

  const now = new Date();
  const updates = [];
  const byHash = new Map();
  for (const message of messages) {
    const text = embeddingText(message);
    if (!text) {
      updates.push({ id: message._id, vector: undefined });
      continue;
    }
    const hash = hashOf(text);
    if (!byHash.has(hash)) byHash.set(hash, { text, ids: [] });
    byHash.get(hash).ids.push(message._id);
  }

  // What the cache has already, then the model for the rest.
  const cached = await EmbeddingCache.find({ model, hash: { $in: [...byHash.keys()] } })
    .select('+vector hash')
    .lean();
  const vectorOf = new Map(cached.map((entry) => [entry.hash, entry.vector]));
  const missing = [...byHash.keys()].filter((hash) => !vectorOf.has(hash));

  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const hashes = missing.slice(i, i + EMBED_BATCH);
    const vectors = await ai.embed(
      hashes.map((hash) => byHash.get(hash).text),
      { purpose: 'document' },
    );
    hashes.forEach((hash, j) => vectorOf.set(hash, vectors[j]));
    // Another process may have cached the same text a moment ago. Its vector
    // is as good as this one, so the duplicate is not written.
    await EmbeddingCache.insertMany(
      hashes.map((hash, j) => ({ model, hash, vector: vectors[j] })),
      { ordered: false },
    ).catch((err) => {
      if (err.code !== 11000 && !err.writeErrors?.every((writeError) => writeError.code === 11000)) throw err;
    });
  }

  for (const [hash, { ids: sameText }] of byHash) {
    for (const id of sameText) updates.push({ id, vector: vectorOf.get(hash) });
  }

  await Message.bulkWrite(
    updates.map(({ id, vector }) => ({
      updateOne: {
        filter: { _id: id },
        update: vector
          ? { $set: { embedding: vector, embeddingModel: model, embeddedAt: now } }
          : { $set: { embeddingModel: model, embeddedAt: now }, $unset: { embedding: 1 } },
      },
    })),
  );

  return { embedded: updates.length, asked: missing.length };
}
