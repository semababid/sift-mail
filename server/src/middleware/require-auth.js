import { User } from '../models/index.js';
import { verifyAccessToken } from '../services/token.service.js';
import { ACCESS_COOKIE } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';

// Reads the access token from the cookie, falling back to a bearer header so
// the API stays usable from curl and from tests.
function extractToken(req) {
  const fromCookie = req.cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;

  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);

  return null;
}

export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized();

    const { sub } = verifyAccessToken(token);
    const user = await User.findById(sub);
    if (!user) throw unauthorized();

    req.user = user;
    req.userId = user._id;
    next();
  } catch (err) {
    next(err);
  }
}
