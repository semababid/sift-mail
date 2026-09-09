import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { env, isProd } from './config/env.js';
import { logger } from './config/logger.js';
import { apiRouter } from './routes/index.js';
import { errorHandler } from './middleware/error.js';
import { apiLimiter } from './middleware/rate-limit.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Behind Fly or Railway there is exactly one proxy in front of this process.
  // Naming the hop count rather than passing `true` matters: `true` makes the
  // app believe any X-Forwarded-For a client sends, which hands anyone a fresh
  // rate limit bucket per request.
  if (isProd) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
      ok: mongoose.connection.readyState === 1,
      mongo: states[mongoose.connection.readyState] ?? 'unknown',
      uptime: Math.round(process.uptime()),
    });
  });

  app.use('/api', apiLimiter, apiRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'not found', code: 'not_found' });
  });

  app.use(errorHandler);

  return app;
}
