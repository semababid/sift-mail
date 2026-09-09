import mongoose from 'mongoose';
import { env, isProd } from './env.js';
import { logger } from './logger.js';

const MAX_ATTEMPTS = 5;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectDb() {
  mongoose.set('strictQuery', true);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // Mongoose builds any missing index on every boot. Convenient locally,
      // dangerous on a populated collection, so production builds them
      // deliberately through scripts/sync-indexes.js instead.
      await mongoose.connect(env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        autoIndex: !isProd,
      });
      logger.info({ db: mongoose.connection.name }, 'mongo connected');
      return mongoose.connection;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      const backoff = 2 ** attempt * 250;
      logger.warn({ attempt, backoff, err: err.message }, 'mongo connect failed, retrying');
      await wait(backoff);
    }
  }
}

export async function disconnectDb() {
  await mongoose.connection.close();
}
