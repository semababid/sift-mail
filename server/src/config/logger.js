import pino from 'pino';
import { env, isProd } from './env.js';

// pino-http logs request and response headers. Without this the log store
// ends up holding every session token that ever passed through. Exported so
// the test can build a logger with the same rules and read what it writes.
export const REDACT = {
  paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  censor: '[redacted]',
};

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: REDACT,
  transport: isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
});
