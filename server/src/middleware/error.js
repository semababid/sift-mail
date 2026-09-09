import { ZodError } from 'zod';
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

  // A zod error reaching here came from a service rather than the validate
  // middleware, so give it the same response shape either way.
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'validation failed',
      code: 'invalid_body',
      fields: Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message])),
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({ error: 'that already exists', code: 'duplicate' });
  }

  // A malformed ObjectId in a route parameter. Nothing with that id can exist,
  // so answer as though nothing was found rather than as a fault.
  if (err?.name === 'CastError') {
    return res.status(404).json({ error: 'not found', code: 'not_found' });
  }

  if (err?.name === 'ValidationError') {
    return res.status(400).json({
      error: 'validation failed',
      code: 'invalid_body',
      fields: Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])),
    });
  }

  // body-parser rejects an unparseable or oversized body with the status
  // already set. Without this it would surface as a 500 and look like a server
  // fault rather than a bad request.
  if (err?.type && Number.isInteger(err.status) && err.status < 500) {
    return res.status(err.status).json({
      error: err.type === 'entity.too.large' ? 'request body is too large' : 'request body could not be parsed',
      code: err.type,
    });
  }

  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({
    error: 'something went wrong',
    code: 'internal',
    ...(isProd ? {} : { detail: err.message }),
  });
}
