import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { RefreshToken } from '../models/index.js';
import { unauthorized } from '../lib/errors.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Both token kinds are HS256 and both carry a `typ` claim, so neither can be
// passed off as the other even if the two secrets were ever set to the same
// value. The env schema refuses that too; this is the second lock.
const JWT_OPTS = { algorithms: ['HS256'] };

// A browser that fires two requests after the access token expires sends two
// refreshes with the same cookie. The first wins and rotates. The second
// arrives with a token that is now spent, which looks exactly like a replay.
// Inside this window it is treated as the race it almost certainly is and gets
// a plain 401; the client already holds the newer cookie and retries with it.
// Outside the window it is treated as theft and the whole family goes.
const REUSE_GRACE_MS = 30_000;

// Turns "30d" into milliseconds. Only the units jwt itself accepts.
function ttlToMs(ttl) {
  const [, amount, unit] = /^(\d+)([smhd])$/.exec(ttl);
  return Number(amount) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

export const REFRESH_TTL_MS = ttlToMs(env.REFRESH_TOKEN_TTL);
export const ACCESS_TTL_MS = ttlToMs(env.ACCESS_TOKEN_TTL);

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id ?? user._id.toString(), typ: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, JWT_OPTS);
  } catch {
    throw unauthorized('invalid or expired token', 'bad_access_token');
  }
  if (payload.typ !== 'access') throw unauthorized('invalid or expired token', 'bad_access_token');
  return payload;
}

export async function issueRefreshToken(userId, { family, userAgent } = {}) {
  const raw = jwt.sign(
    { sub: userId.toString(), jti: crypto.randomUUID(), typ: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.REFRESH_TOKEN_TTL },
  );

  await RefreshToken.create({
    userId,
    tokenHash: sha256(raw),
    family: family ?? crypto.randomUUID(),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    userAgent: userAgent ?? null,
  });

  return raw;
}

// Verifies a refresh token and burns it. Returns the stored record so the
// caller can inherit its family.
export async function consumeRefreshToken(raw) {
  let payload;
  try {
    payload = jwt.verify(raw, env.JWT_REFRESH_SECRET, JWT_OPTS);
  } catch {
    throw unauthorized('invalid or expired session', 'bad_refresh_token');
  }
  if (payload.typ !== 'refresh') throw unauthorized('invalid or expired session', 'bad_refresh_token');

  const tokenHash = sha256(raw);
  const now = new Date();

  // One atomic claim. Of two requests carrying the same token, exactly one
  // gets the document back with usedAt set; the other gets null.
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null },
    { usedAt: now },
    { new: true },
  );
  if (claimed) return claimed;

  const stored = await RefreshToken.findOne({ tokenHash });
  if (!stored) throw unauthorized('invalid or expired session', 'bad_refresh_token');

  const spentMsAgo = stored.usedAt ? now - stored.usedAt : Infinity;
  if (!stored.revokedAt && spentMsAgo < REUSE_GRACE_MS) {
    throw unauthorized('session was just refreshed, retry', 'stale_refresh_token');
  }

  await revokeFamily(stored.family);
  throw unauthorized('session reuse detected, please sign in again', 'refresh_reuse');
}

export async function revokeFamily(family) {
  await RefreshToken.updateMany({ family, revokedAt: null }, { revokedAt: new Date() });
}
