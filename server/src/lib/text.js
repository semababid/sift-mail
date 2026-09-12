const REPLY_PREFIX = /^\s*((re|aw|fwd|fw|wg)\s*(\[\d+\])?\s*:\s*)+/i;

// Strips the Re:/Fwd: pile off a subject and flattens the rest, so replies land
// in the same thread as the message they answer. German clients send Aw: and
// Wg:, which is the whole reason this is a list and not two strings.
export function normalizeSubject(subject) {
  return (subject ?? '')
    .replace(REPLY_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// What the message list shows under the subject. Collapses whitespace so a
// wrapped plain-text body does not turn into ragged preview text.
export function makeSnippet(body, length = 140) {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= length) return flat;
  return `${flat.slice(0, length).trimEnd()}...`;
}
