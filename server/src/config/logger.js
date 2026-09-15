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
  // The process id and host name are the same on every line of a local run,
  // and the response time is already part of each request line.
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,responseTime' } },
});

// How pino-http records each request. In production that is a full structured
// record, headers included with the session tokens redacted, for a log store
// to search. In a terminal the same record fills the screen, so development
// gets one line per request instead: method, path, status and time. There,
// client errors are logged as warnings and server errors as errors, so they
// stand out from the rest.
export function requestLogging({ detailed }) {
  const options = { autoLogging: { ignore: (req) => req.url === '/health' } };
  if (detailed) return options;

  return {
    ...options,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(responseTime)}ms`,
    customErrorMessage: (req, res, err) => `${req.method} ${req.originalUrl} ${res.statusCode} ${err.message}`,
    serializers: { req: () => undefined, res: () => undefined },
  };
}
