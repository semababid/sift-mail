import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({
      ok: mongoose.connection.readyState === 1,
      mongo: states[mongoose.connection.readyState] ?? 'unknown',
      uptime: Math.round(process.uptime()),
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}
