import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

// Vectors already made, by model and by a hash of the exact text embedded, so
// the same text is never sent to the model twice. Mail between Sift users is
// the common case: the sender's copy and every recipient's copy carry the
// same subject and body, and cost one call between them.
//
// Shared across users, which gives nobody access to anything: a vector is only
// ever found by the hash of a text the looker already has. Entries expire
// after 90 days, so a vector outlasts the mail it came from by at most that.
const embeddingCacheSchema = new mongoose.Schema({
  // provider.embeddingModel, as "ollama/bge-m3". Vectors from two models
  // cannot be compared, so the model is part of the key.
  model: { type: String, required: true },
  hash: { type: String, required: true },
  vector: { type: [Number], required: true, select: false },
  createdAt: { type: Date, default: Date.now },
});

embeddingCacheSchema.index({ model: 1, hash: 1 }, { unique: true });
// Ninety days covers re-running a backfill, without the cache growing into a
// second copy of every mailbox.
embeddingCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

embeddingCacheSchema.plugin(toJSON);

export const EmbeddingCache = mongoose.model('EmbeddingCache', embeddingCacheSchema);
