import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { User } from '../src/models/index.js';
import { connectImap } from '../src/services/imap/client.js';
import { fetchPendingBodies, importNewMail } from '../src/services/imap/importer.js';
import { flushEmbeddings } from '../src/services/embedding/queue.js';
import { stopTriage } from '../src/services/triage/queue.js';

// Keeps one IMAP inbox in step with a Sift account. It imports what is new,
// then fills in message bodies, then waits: the server announces new mail
// while the connection idles, and a slower timer covers a server that does
// not. A dropped connection is retried with a growing pause.
//
//   node scripts/imap-sync.js          keeps running
//   node scripts/imap-sync.js --once   one import and body pass, then exits

const { values: opts } = parseArgs({ options: { once: { type: 'boolean', default: false } } });

const MAILBOX = 'INBOX';
// Some servers drop the notification for mail that arrives while the
// connection is being re-established. This catches what they missed.
const POLL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const log = logger.child({ worker: 'imap-sync' });

if (!env.IMAP_HOST) {
  log.info('IMAP is not configured, so there is nothing to sync. Fill in the IMAP_ keys in .env to turn it on.');
  process.exit(0);
}

await connectDb();
const owner = await User.findOne({ email: env.IMAP_OWNER.toLowerCase() });
if (!owner) {
  log.fatal({ owner: env.IMAP_OWNER }, 'IMAP_OWNER does not match any Sift account');
  await disconnectDb();
  process.exit(1);
}

const account = env.IMAP_USER.toLowerCase();
let stopping = false;
let client = null;

// One pass: headers, then bodies until none are left.
async function syncOnce() {
  const { stored, uidValidity } = await importNewMail({ user: owner, client, account, mailbox: MAILBOX });
  if (stored > 0) log.info({ stored }, 'imported new mail');

  let filled = 0;
  for (;;) {
    const done = await fetchPendingBodies({ user: owner, client, account, mailbox: MAILBOX, uidValidity });
    if (done === 0) break;
    filled += done;
  }
  if (filled > 0) log.info({ bodies: filled }, 'fetched message bodies');
}

// Runs a sync, or marks that another is wanted when one is already running,
// so a burst of new-mail events turns into one follow-up pass, not ten.
function scheduler() {
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await syncOnce();
      } while (again && !stopping);
    } catch (err) {
      log.error({ err }, 'sync failed');
      // The connection is probably the problem. Closing it sends the main
      // loop round to reconnect.
      client?.raw.close();
    } finally {
      running = false;
    }
  };
  return run;
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'stopping');
  await client?.close();
  // Embeds what the last pass imported before the database goes away. Triage
  // is too slow to wait for, and is left to its backfill.
  await Promise.all([flushEmbeddings(), stopTriage()]);
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

let backoff = 1_000;
while (!stopping) {
  try {
    client = await connectImap({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
    });
    log.info({ host: env.IMAP_HOST, account, owner: owner.email }, 'connected');

    if (opts.once) {
      await syncOnce();
      await stop('done');
    }

    backoff = 1_000;
    const run = scheduler();
    const closed = new Promise((resolve) => client.raw.once('close', resolve));
    client.raw.on('exists', run);
    const timer = setInterval(run, POLL_MS);

    await run();
    // imapflow idles on its own while nothing else is happening, and the
    // server sends "exists" into that idle when new mail lands.
    await closed;
    clearInterval(timer);
    if (!stopping) log.warn('connection closed, reconnecting');
  } catch (err) {
    if (stopping) break;
    // A refused login will not fix itself, so it is not retried in a loop.
    if (err.authenticationFailed) {
      log.fatal('the IMAP server refused IMAP_USER and IMAP_PASSWORD');
      await disconnectDb();
      process.exit(1);
    }
    log.warn({ err: err.message, retryInMs: backoff }, 'could not reach the IMAP server');
  }
  if (stopping) break;
  await new Promise((resolve) => setTimeout(resolve, backoff));
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}
