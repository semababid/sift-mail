import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

// Refresh tokens are stored so they can be revoked, which a stateless JWT
// cannot be. Only the hash is kept: a leaked database dump should not hand
// anyone a working session.
//
// Every token carries a `family`, set when the user logs in and inherited by
// each rotation. If a token that has already been rotated is presented again,
// the most likely explanation is that someone copied it, so the whole family
// is revoked and both the thief and the real user get logged out.
const refreshTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true },
);

// Mongo removes expired tokens on its own, so nothing has to sweep the table.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ family: 1 });

refreshTokenSchema.plugin(toJSON);

export const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);
