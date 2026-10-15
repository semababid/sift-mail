import { withoutQuotedLines } from './text.js';

// What a message is embedded as: its subject, then the start of its body.
// The subject says what a mail is about more reliably than anything else in
// it, and the opening lines usually say why it was sent. A long body is cut:
// embedding models read a limited amount, and the end of a long mail is
// mostly a signature or earlier mail quoted below.
export const EMBED_BODY_CHARS = 1500;

// Lines quoted from earlier mail, which a reply carries under "> ", are left
// out. They belong to the message they came from, which has a vector of its
// own, and would otherwise make every reply look like its parent.
export function embeddingText({ subject = '', bodyText = '' }) {
  const body = withoutQuotedLines(bodyText)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EMBED_BODY_CHARS);
  return [subject.trim(), body].filter(Boolean).join('\n\n');
}
