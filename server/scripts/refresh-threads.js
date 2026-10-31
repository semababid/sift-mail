import { parseArgs } from 'node:util';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Thread, User } from '../src/models/index.js';
import { refreshThread } from '../src/services/thread-summary.js';

// Rebuilds the stored summary of every thread from its messages: for after the
// summary gains a field, as the triage bucket did in stage 6.3, or after a
// script changed messages without going through the services. Safe to run any
// time, since a summary is only ever worked out from the messages.
//
//   npm run threads:refresh --workspace=server
//   npm run threads:refresh --workspace=server -- --email semab@sift.example

const { values: opts } = parseArgs({ options: { email: { type: 'string' } } });

await connectDb();
const filter = {};
if (opts.email) {
  const user = await User.findOne({ email: opts.email.toLowerCase() });
  if (!user) {
    console.error(`No account for ${opts.email}.`);
    await disconnectDb();
    process.exit(1);
  }
  filter.userId = user._id;
}

const total = await Thread.countDocuments(filter);
let done = 0;
for await (const { _id } of Thread.find(filter).select('_id').lean().cursor()) {
  await refreshThread(_id);
  done += 1;
  if (done % 100 === 0 || done === total) process.stdout.write(`\r  ${done}/${total} threads`);
}
console.log(`\n${done} thread summaries rebuilt.`);
await disconnectDb();
