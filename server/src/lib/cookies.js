import { isProd } from '../config/env.js';
import { ACCESS_TTL_MS, REFRESH_TTL_MS } from '../services/token.service.js';

export const ACCESS_COOKIE = 'sift_access';
export const REFRESH_COOKIE = 'sift_refresh';

// In production the API and the client sit on different domains, which needs
// SameSite=None, which browsers only accept alongside Secure. Locally they are
// both on localhost, so Lax works and survives a plain http origin.
const base = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? 'none' : 'lax',
};

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: ACCESS_TTL_MS, path: '/' });
  // Scoped to the auth routes, so it is not attached to every request the
  // client makes.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    maxAge: REFRESH_TTL_MS,
    path: '/api/auth',
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth' });
}
