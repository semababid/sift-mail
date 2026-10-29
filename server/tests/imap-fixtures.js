// A fake IMAP mailbox and the messages in it, for the importer tests.

export const ACCOUNT = 'sync@mail.example';
export const MARA = { name: 'Mara Klein', address: 'mara@elsewhere.example' };

const base64 = (content) =>
  Buffer.from(content)
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');

// The body of a message as MIME: plain, HTML, both, and any attachments.
// `attachments` are { filename, contentType, content }, and one with a `cid`
// is an inline image the HTML part refers to.
function body({ text, html, attachments = [] }) {
  const inline = attachments.filter((file) => file.cid);
  const attached = attachments.filter((file) => !file.cid);

  const part = (type, content) => [`Content-Type: ${type}; charset=utf-8`, '', content];
  const filePart = (file) => [
    `Content-Type: ${file.contentType}${file.filename ? `; name="${file.filename}"` : ''}`,
    'Content-Transfer-Encoding: base64',
    file.cid
      ? `Content-ID: <${file.cid}>\r\nContent-Disposition: inline`
      : `Content-Disposition: attachment${file.filename ? `; filename="${file.filename}"` : ''}`,
    '',
    base64(file.content),
  ];
  const multipart = (subtype, boundary, parts) => [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    '',
    ...parts.flatMap((lines) => [`--${boundary}`, ...lines]),
    `--${boundary}--`,
    '',
  ];

  let main;
  if (text !== undefined && html !== undefined) {
    main = multipart('alternative', 'alt', [part('text/plain', text), part('text/html', html)]);
  } else if (html !== undefined) {
    main = part('text/html', html);
  } else {
    main = part('text/plain', text ?? '');
  }
  if (inline.length > 0) main = multipart('related', 'rel', [main, ...inline.map(filePart)]);
  if (attached.length > 0) main = multipart('mixed', 'mix', [main, ...attached.map(filePart)]);
  return main;
}

// `extraHeaders` are further header lines as they are written, such as a
// List-Id.
export function mime({ from, to, subject, messageId, inReplyTo, references, date, extraHeaders = [], ...content }) {
  const headers = [
    `From: ${from.name} <${from.address}>`,
    `To: ${to.map((person) => person.address).join(', ')}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    messageId && `Message-ID: ${messageId}`,
    inReplyTo && `In-Reply-To: ${inReplyTo}`,
    references && `References: ${references}`,
    ...extraHeaders,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  return Buffer.from([...headers, ...body(content), ''].join('\r\n'));
}

// One message on the fake server, in both forms the importer asks for.
export function mail(uid, overrides = {}) {
  const fields = {
    from: MARA,
    to: [{ address: ACCOUNT }],
    subject: `Nachricht ${uid}`,
    messageId: `<m${uid}@elsewhere.example>`,
    inReplyTo: undefined,
    references: undefined,
    date: new Date(Date.UTC(2026, 4, 1, 9, uid)),
    text: `Text ${uid}`,
    html: undefined,
    attachments: [],
    seen: false,
    ...overrides,
  };
  return {
    uid,
    flags: new Set(fields.seen ? ['\\Seen'] : []),
    internalDate: fields.date,
    envelope: {
      date: fields.date,
      subject: fields.subject,
      messageId: fields.messageId,
      inReplyTo: fields.inReplyTo,
      from: [fields.from],
      to: fields.to,
      cc: [],
    },
    references: fields.references ?? '',
    raw: mime(fields),
  };
}

// A mailbox on an IMAP server, with the four calls the importer makes.
export function fakeMailbox(messages = [], { uidValidity = '7' } = {}) {
  const box = new Map(messages.map((message) => [message.uid, message]));
  const state = { uidValidity, headerRequests: [], sourceRequests: [] };
  const client = {
    async open() {
      return { uidValidity: state.uidValidity };
    },
    async uids() {
      return [...box.keys()];
    },
    async headers(uids) {
      state.headerRequests.push([...uids]);
      return uids
        .filter((uid) => box.has(uid))
        .map((uid) => {
          const { raw, ...item } = box.get(uid);
          return item;
        });
    },
    async source(uid) {
      state.sourceRequests.push(uid);
      return box.get(uid)?.raw ?? null;
    },
  };
  return { client, state, box, add: (message) => box.set(message.uid, message) };
}
