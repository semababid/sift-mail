import { ImapFlow } from 'imapflow';

// The four calls the importer needs from a mailbox, over a real IMAP server.
// Kept this thin so the importer can be tested against a fake with the same
// shape, and so imapflow's own objects never reach the database code.

// The References header as imapflow returns it: raw header lines, possibly
// folded across several.
function referencesFrom(buffer) {
  if (!buffer) return '';
  return buffer
    .toString('utf8')
    .replace(/\r?\n[ \t]+/g, ' ')
    .replace(/^references:\s*/i, '')
    .trim();
}

export async function connectImap({ host, port, user, password }) {
  const client = new ImapFlow({
    host,
    port,
    // 993 is TLS from the first byte. 143 upgrades with STARTTLS, which
    // imapflow does on its own.
    secure: port === 993,
    auth: { user, pass: password },
    // imapflow logs every IMAP command at info level by default.
    logger: false,
    // Fail a stuck connection within seconds rather than minutes. The worker
    // reconnects on its own.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 5 * 60_000,
  });
  await client.connect();

  return {
    raw: client,

    async open(mailbox) {
      const box = await client.mailboxOpen(mailbox);
      return { uidValidity: String(box.uidValidity) };
    },

    async uids() {
      return (await client.search({ all: true }, { uid: true })) || [];
    },

    async headers(uids) {
      if (uids.length === 0) return [];
      const messages = await client.fetchAll(
        uids.join(','),
        { uid: true, flags: true, envelope: true, internalDate: true, headers: ['references'] },
        { uid: true },
      );
      return messages.map((message) => ({
        uid: message.uid,
        flags: message.flags ?? new Set(),
        internalDate: message.internalDate,
        envelope: message.envelope ?? {},
        references: referencesFrom(message.headers),
      }));
    },

    async source(uid) {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return message?.source ?? null;
    },

    async close() {
      await client.logout().catch(() => client.close());
    },
  };
}
