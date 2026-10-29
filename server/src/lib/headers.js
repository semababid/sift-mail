// References grow by one id per reply. Threading only needs the recent end,
// and mail clients commonly trim the chain around this length.
export const MAX_REFERENCES = 20;

// Message-IDs the way headers carry them: "<a@x> <b@y>", sometimes separated
// by commas, sometimes already an array from the MIME parser. Anything that
// cannot be an id is dropped rather than stored and never matched.
export function parseMessageIds(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  const ids = [];
  const seen = new Set();

  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const trimmed = part.trim();
    if (!trimmed) continue;
    // A bare id, without its angle brackets, is common enough to accept.
    const id = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
    if (!/^<[^<>\s]+>$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

// The chain to store on a message, from its In-Reply-To and References
// headers. The parent is always in the chain, even when the sending client
// left it out of References, so one index answers "which message names this
// one" without a second lookup on In-Reply-To. The oldest ids are dropped
// when the chain gets long; threading works from the recent end.
export function referenceChain({ inReplyTo, references } = {}) {
  const chain = parseMessageIds(references);
  const parent = parseMessageIds(inReplyTo)[0] ?? null;
  if (parent && !chain.includes(parent)) chain.push(parent);
  return { inReplyTo: parent, references: chain.slice(-MAX_REFERENCES) };
}

// Precedence values that mark mail sent to many people at once.
const BULK_PRECEDENCE = ['bulk', 'list', 'junk'];

// Whether a message came from a mailing list, read from the headers that mail
// sent to many people carries: List-Id, List-Unsubscribe, or Precedence: bulk.
// `headers` is the header map mailparser gives, which keeps the List-*
// headers together under "list". Answers { bulk, listName }. The name is the
// one the List-Id gives, or its id when it gives none, which mailparser fills
// in itself.
export function mailingListOf(headers) {
  const list = headers?.get('list');
  const precedence = String(headers?.get('precedence') ?? '')
    .trim()
    .toLowerCase();
  const bulk = Boolean(list?.id || list?.unsubscribe || BULK_PRECEDENCE.includes(precedence));
  const name = list?.id?.name || null;
  return { bulk, listName: name ? String(name).slice(0, 120) : null };
}

