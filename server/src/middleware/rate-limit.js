import rateLimit from 'express-rate-limit';
import { HttpError } from '../lib/errors.js';
import { env } from '../config/env.js';

// Rate limit responses go through the normal error handler so a throttled
// client gets the same JSON shape as every other failure.
const handler = (req, res, next, options) => {
  next(new HttpError(429, options.message, 'rate_limited'));
};

const common = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
  // The test suite makes far more auth calls than a person would. Limits stay
  // on in development so they are exercised by hand, and the rate limit itself
  // is tested by running a case with NODE_ENV unset.
  skip: () => env.NODE_ENV === 'test',
};

// Guessing passwords and farming accounts are the expensive attacks, so these
// two are tight. Counting failures only would let an attacker with a valid
// account hold the window open, so every attempt counts.
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: 'too many attempts, try again in a few minutes',
});

// Refreshing is something a legitimate client does on a timer, so this exists
// to catch a loop rather than to stop an attacker.
export const refreshLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: 'too many refresh attempts',
});

export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: 'too many requests',
});
