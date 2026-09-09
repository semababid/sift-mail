import { HttpError } from '../lib/errors.js';
import { isProd } from '../config/env.js';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err.fields ? { fields: err.fields } : {}),
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({ error: 'that already exists', code: 'duplicate' });
  }

  if (err?.name === 'ValidationError') {
    return res.status(400).json({
      error: 'validation failed',
      code: 'invalid_body',
      fields: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])),
    });
  }

  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({
    error: 'something went wrong',
    code: 'internal',
    ...(isProd ? {} : { detail: err.message }),
  });
}
