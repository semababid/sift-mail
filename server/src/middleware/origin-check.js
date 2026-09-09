import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Sessions live in cookies, and in production the cookie is SameSite=None so
// it can cross from the client's domain to the API's. That means any site can
// make a browser send it. CORS only stops the other site from reading the
// response; the request still runs.
//
// Browsers attach an Origin header to every cross-site request and to every
// same-origin fetch, so for anything that changes state, an Origin that is
// present and not ours is refused. A request with no Origin at all comes from
// curl or a server, which has no cookie jar to abuse.
export function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin && origin !== env.CLIENT_ORIGIN) {
    return next(new HttpError(403, 'cross-site request refused', 'bad_origin'));
  }

  next();
}
