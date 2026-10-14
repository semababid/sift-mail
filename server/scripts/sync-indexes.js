import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import '../src/models/index.js';
import { ensureVectorIndex, VECTOR_INDEX } from '../src/services/vector-search.js';

// Builds anything missing and drops indexes that are no longer declared in a
// schema, then sets up the Atlas vector index. Run it on deploy; production
// boots with autoIndex off.
await connectDb();

for (const [name, model] of Object.entries(mongoose.models)) {
  const changes = await model.syncIndexes();
  logger.info({ model: name, dropped: changes }, 'indexes synced');
}

logger.info({ index: VECTOR_INDEX }, 'checking the vector index, which takes about half a minute when it is new');
const vector = await ensureVectorIndex();
if (vector.action === 'skipped') {
  logger.warn({ index: VECTOR_INDEX }, 'not Atlas, so no vector index: vector search needs MONGO_URI to point at Atlas');
} else {
  logger.info({ index: VECTOR_INDEX, ...vector }, 'vector index ready');
}

await disconnectDb();
