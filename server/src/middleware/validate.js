import { badRequest } from '../lib/errors.js';

// Builds middleware from a set of zod schemas, one per request part.
//
// Parsed output goes on `req.valid` rather than back onto `req.body` and
// friends. Express 5 exposes `req.query` as a getter with no setter, so
// assigning to it throws, and having one obvious place for validated data beats
// remembering which parts were overwritten and which were not.
export function validate(schemas) {
  return (req, res, next) => {
    req.valid = {};
    const fields = {};

    for (const [part, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[part]);
      if (result.success) {
        req.valid[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const path = issue.path.join('.');
          fields[path || part] = issue.message;
        }
      }
    }

    if (Object.keys(fields).length > 0) {
      const err = badRequest('validation failed', 'invalid_body');
      err.fields = fields;
      return next(err);
    }

    next();
  };
}
