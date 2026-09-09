import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import '../src/models/index.js';

// Builds anything missing and drops indexes that are no longer declared in a
// schema. Run it on deploy; production boots with autoIndex off.
await connectDb();

for (const [name, model] of Object.entries(mongoose.models)) {
  const changes = await model.syncIndexes();
  logger.info({ model: name, dropped: changes }, 'indexes synced');
}

await disconnectDb();
