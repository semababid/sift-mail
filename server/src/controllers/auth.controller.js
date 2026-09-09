import { z } from 'zod';
import * as authService from '../services/auth.service.js';
import { User } from '../models/index.js';
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeFamily,
} from '../services/token.service.js';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '../lib/cookies.js';
import { badRequest, unauthorized } from '../lib/errors.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'password must be at least 10 characters'),
  name: z.string().min(1).max(80),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const err = badRequest('validation failed', 'invalid_body');
    err.fields = Object.fromEntries(
      result.error.issues.map((i) => [i.path.join('.'), i.message]),
    );
    throw err;
  }
  return result.data;
}

async function startSession(res, user, req, family) {
  const refreshToken = await issueRefreshToken(user._id, {
    family,
    userAgent: req.get('user-agent'),
  });
  setAuthCookies(res, { accessToken: signAccessToken(user), refreshToken });
}

export async function register(req, res, next) {
  try {
    const body = parse(registerSchema, req.body);
    const user = await authService.register(body);
    await startSession(res, user, req);
    res.status(201).json({ user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const body = parse(loginSchema, req.body);
    const user = await authService.login(body);
    await startSession(res, user, req);
    res.json({ user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized('no session', 'no_refresh_token');

    const stored = await consumeRefreshToken(raw);
    const user = await User.findById(stored.userId);
    if (!user) throw unauthorized('no session', 'no_refresh_token');

    await startSession(res, user, req, stored.family);
    res.json({ user: user.toJSON() });
  } catch (err) {
    if (err.code === 'refresh_reuse' || err.code === 'bad_refresh_token') clearAuthCookies(res);
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (raw) {
      const stored = await consumeRefreshToken(raw).catch(() => null);
      if (stored) await revokeFamily(stored.family);
    }
    clearAuthCookies(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function me(req, res) {
  res.json({ user: req.user.toJSON() });
}
