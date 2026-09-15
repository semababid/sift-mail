// Loose on purpose. The server checks every address properly; this only
// catches the obvious slips before anything is sent, such as a missing @ or a
// domain typed halfway.
const LOOKS_LIKE_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;

// Reads what was typed into a To, Cc or Bcc field. Commas, semicolons and line
// breaks all separate addresses, and "Mara Klein <mara@example.org>" keeps just
// the part in angle brackets, so addresses pasted from another client work.
// Anything that does not look like an address comes back in `invalid`, as typed.
export function parseAddressList(text) {
  const addresses = [];
  const invalid = [];
  const seen = new Set();

  for (const part of text.split(/[,;\n]/).map((piece) => piece.trim()).filter(Boolean)) {
    const address = (part.match(/<([^>]+)>\s*$/)?.[1] ?? part).trim().toLowerCase();
    if (!LOOKS_LIKE_ADDRESS.test(address)) {
      invalid.push(part);
    } else if (!seen.has(address)) {
      seen.add(address);
      addresses.push(address);
    }
  }

  return { addresses, invalid };
}

export const formatAddressList = (addresses) => addresses.join(', ');
