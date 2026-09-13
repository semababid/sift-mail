import { badRequest } from './errors.js';

// A page cursor is the sort key of the last row on the page: its timestamp
// and its _id. Opaque to the client, but not a secret. Every query is scoped
// to the signed-in user, so a hand-edited cursor can only move around inside
// that user's own mail.
export function encodeCursor(row, dateField) {
  const payload = { t: row[dateField].getTime(), id: row._id.toString() };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor) {
  try {
    const { t, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isFinite(t) || !/^[a-f0-9]{24}$/.test(id)) throw new Error('bad shape');
    return { t: new Date(t), id };
  } catch {
    throw badRequest('that page cursor is not valid', 'invalid_cursor');
  }
}
