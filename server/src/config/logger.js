import pino from 'pino';
import { env, isProd } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // pino-http logs request and response headers. Without this the log store
  // ends up holding every session token that ever passed through.
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    censor: '[redacted]',
  },
  transport: isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
});
