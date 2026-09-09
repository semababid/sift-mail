import * as authService from '../services/auth.service.js';
import { User } from '../models/index.js';
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeFamily,
} from '../services/token.service.js';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';

// Express 5 forwards a rejected promise to the error handler on its own, so
// these do not need to wrap themselves in try/catch. The one exception is
// refresh, which has cleanup to do before the error moves on.
async function startSession(res, user, req, family) {
  const refreshToken = await issueRefreshToken(user._id, {
    family,
    userAgent: req.get('user-agent'),
  });
  setAuthCookies(res, { accessToken: signAccessToken(user), refreshToken });
}

export async function register(req, res) {
  const user = await authService.register(req.valid.body);
  await startSession(res, user, req);
  res.status(201).json({ user: user.toJSON() });
}

export async function login(req, res) {
  const user = await authService.login(req.valid.body);
  await startSession(res, user, req);
  res.json({ user: user.toJSON() });
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
    // A bad or replayed token means the cookies on this browser are worthless.
    // Clearing them stops the client retrying with the same dead credentials.
    if (err.code === 'refresh_reuse' || err.code === 'bad_refresh_token') clearAuthCookies(res);
    next(err);
  }
}

export async function logout(req, res) {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (raw) {
    const stored = await consumeRefreshToken(raw).catch(() => null);
    if (stored) await revokeFamily(stored.family);
  }
  clearAuthCookies(res);
  res.status(204).end();
}

export async function me(req, res) {
  res.json({ user: req.user.toJSON() });
}
