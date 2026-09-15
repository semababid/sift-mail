import { messageDate } from '../../lib/format.js';

// The server's rule: German clients send AW: and WG:, which is why this is a
// list rather than just Re: and Fwd:.
const REPLY_PREFIX = /^\s*((re|aw|fwd|fw|wg)\s*(\[\d+\])?\s*:\s*)+/i;

// One "Re:" in front, however many prefixes the subject already carries. A
// message with no subject gets a reply with no subject, not a lone "Re:".
export function replySubject(subject) {
  const bare = (subject ?? '').replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim();
  return bare ? `Re: ${bare}` : '';
}

const addressesOf = (people) => people.map((person) => person.address);

// Who a reply goes to. A reply to someone else's message answers its sender;
// a reply to one you sent yourself goes back to the people you sent it to, as
// a follow-up. Reply all adds everyone else on the message, never yourself.
// A note sent only to yourself is answered to yourself.
export function replyRecipients(message, selfAddress, { all = false } = {}) {
  const mine = message.from.address === selfAddress;
  const primary = mine ? addressesOf(message.to) : [message.from.address, ...(all ? addressesOf(message.to) : [])];

  const to = [...new Set(primary)].filter((address) => address !== selfAddress);
  const cc = all ? [...new Set(addressesOf(message.cc))].filter((address) => address !== selfAddress && !to.includes(address)) : [];

  return { to: to.length > 0 || cc.length > 0 ? to : [selfAddress], cc };
}

// The message being answered, under the reply, each line marked with "> " the
// way plain-text mail quotes. The two empty lines at the top are where the
// reply gets written.
export function quoteMessage(message) {
  const who = message.from.name || message.from.address;
  const text = (message.bodyText ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');

  const quoted = text
    ? text
        .split('\n')
        .map((line) => (line.startsWith('>') ? `>${line}` : line ? `> ${line}` : '>'))
        .join('\n')
    : '> (This message has no plain text.)';

  return `\n\nOn ${messageDate(message.sentAt)}, ${who} wrote:\n${quoted}`;
}
