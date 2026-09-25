import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';

// Mail to addresses outside Sift, handed to an SMTP server with Nodemailer.
// Everyone with a Sift account gets an inbox copy written by the mail service
// instead, so this only ever carries the rest.

let transport;

function transportFromEnv() {
  if (!env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 speaks TLS from the first byte. 587 and 25 start plain and upgrade
    // with STARTTLS, which Nodemailer does on its own when `secure` is false.
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
}

// Tests hand in a transport of their own. Passing null turns outbound mail off.
export function setOutboundTransport(custom) {
  transport = custom;
}

function getTransport() {
  if (transport === undefined) transport = transportFromEnv();
  return transport;
}

export const isOutboundConfigured = () => getTransport() !== null;

// The address mail leaves from, with the sender's own name on it.
export const outboundFrom = (sender) => ({ name: sender.name, address: env.SMTP_FROM ?? sender.email });

// Sends one message. `to` and `cc` are the full recipient lists as they
// appear in the headers, and `envelopeTo` the addresses this copy actually
// goes to, which leaves out everyone with a Sift account and includes bcc.
// `attachments` are { filename, contentType, content } with content a stream.
export async function sendOutbound({ from, to, cc, envelopeTo, subject, text, messageId, inReplyTo, references, attachments = [] }) {
  const smtp = getTransport();
  if (!smtp) throw new Error('outbound mail is not configured');

  let info;
  try {
    info = await smtp.sendMail({
      from,
      to,
      cc,
      envelope: { from: from.address, to: envelopeTo },
      subject,
      text,
      messageId,
      inReplyTo: inReplyTo ?? undefined,
      references: references.length > 0 ? references : undefined,
      attachments,
    });
  } catch (err) {
    // A 502: the fault is upstream, in the SMTP server or the way to it. The
    // client's message is that the draft is kept and can be sent again.
    const failure = new HttpError(502, 'mail could not be sent', 'smtp_failed');
    failure.cause = err;
    throw failure;
  }

  return { accepted: info.accepted ?? [], rejected: info.rejected ?? [], at: new Date() };
}
