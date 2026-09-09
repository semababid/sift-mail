import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { RefreshToken } from '../models/index.js';
import { unauthorized } from '../lib/errors.js';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Turns "30d" into milliseconds. Only the units jwt itself accepts.
function ttlToMs(ttl) {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) throw new Error(`unsupported TTL format: ${ttl}`);
  const [, amount, unit] = match;
  return Number(amount) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

export const REFRESH_TTL_MS = ttlToMs(env.REFRESH_TOKEN_TTL);
export const ACCESS_TTL_MS = ttlToMs(env.ACCESS_TOKEN_TTL);

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id ?? user._id.toString() }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  });
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    throw unauthorized('invalid or expired token', 'bad_access_token');
  }
}

export async function issueRefreshToken(userId, { family, userAgent } = {}) {
  const raw = jwt.sign(
    { sub: userId.toString(), jti: crypto.randomUUID() },
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
  try {
    jwt.verify(raw, env.JWT_REFRESH_SECRET);
  } catch {
    throw unauthorized('invalid or expired session', 'bad_refresh_token');
  }

  const stored = await RefreshToken.findOne({ tokenHash: sha256(raw) });
  if (!stored) throw unauthorized('invalid or expired session', 'bad_refresh_token');

  if (stored.revokedAt || stored.usedAt) {
    // A token that was already spent is being presented again. Assume it was
    // copied and drop every session descended from the same login.
    await RefreshToken.updateMany(
      { family: stored.family, revokedAt: null },
      { revokedAt: new Date() },
    );
    throw unauthorized('session reuse detected, please sign in again', 'refresh_reuse');
  }

  stored.usedAt = new Date();
  await stored.save();
  return stored;
}

export async function revokeFamily(family) {
  await RefreshToken.updateMany({ family, revokedAt: null }, { revokedAt: new Date() });
}
