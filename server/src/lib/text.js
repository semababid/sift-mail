const REPLY_PREFIX = /^\s*((re|aw|fwd|fw|wg)\s*(\[\d+\])?\s*:\s*)+/i;

// Strips the Re:/Fwd: pile off a subject and flattens the whitespace, keeping
// the case, so a reply can be titled "Re: Wohnung" rather than
// "Re: Aw: Re: Wohnung". German clients send Aw: and Wg:, which is the whole
// reason this is a list and not two strings.
export function stripReplyPrefix(subject) {
  return (subject ?? '').replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim();
}

// The same, lowercased, for matching a reply to the thread it belongs to.
export function normalizeSubject(subject) {
  return stripReplyPrefix(subject).toLowerCase();
}

// What the message list shows under the subject. Collapses whitespace so a
// wrapped plain-text body does not turn into ragged preview text.
export function makeSnippet(body, length = 140) {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= length) return flat;
  return `${flat.slice(0, length).trimEnd()}...`;
}

// The text of a message without the lines it quotes from earlier mail, which
// a reply carries under "> ". Those belong to the message they came from.
export function withoutQuotedLines(text) {
  return (text ?? '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
}
