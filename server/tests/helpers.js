import mongoose from 'mongoose';
import '../src/models/index.js';

export const credentials = { email: 'semab@b-tu.de', password: 'correct-horse', name: 'Semab' };

export async function connect() {
  const { connectDb } = await import('../src/config/db.js');
  await connectDb();
  // Indexes build in the background after connecting. A duplicate-email test
  // that runs before the unique index exists passes for the wrong reason.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}

export async function disconnect() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
}

// Empties every collection but keeps its indexes, which dropping would lose.
export async function clearDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

// Several tests replay an old cookie or fire two requests carrying the same
// one, which needs the cookies under the test's control rather than an agent's.
export function cookieJar() {
  const jar = new Map();

  return {
    capture(res) {
      for (const raw of res.headers['set-cookie'] ?? []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i);
        const value = pair.slice(i + 1);
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (name) => jar.get(name),
    has: (name) => jar.has(name),
  };
}
