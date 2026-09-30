import { createApp } from './app.js';
import { connectDb, disconnectDb } from './config/db.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { flushEmbeddings } from './services/embedding/queue.js';

// Fly and Railway send SIGTERM and wait about this long before killing the
// process. Idle keep-alive connections are closed at once; anything still
// mid-request gets until the deadline.
const SHUTDOWN_DEADLINE_MS = 8_000;

async function main() {
  await connectDb();

  const server = createApp().listen(env.PORT, () => {
    logger.info(`listening on http://localhost:${env.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const deadline = setTimeout(() => {
      logger.error('shutdown deadline passed, exiting');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();

    server.closeIdleConnections();
    server.close(async () => {
      // Vectors for mail written in the last moment, inside the deadline:
      // anything it cuts off is found again by the backfill.
      await flushEmbeddings();
      clearTimeout(deadline);
      await disconnectDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'unhandled rejection');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
