import nodemailer from 'nodemailer';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';

// Sends one test message so an SMTP setup can be checked without going
// through the app. With --ethereal it uses a throwaway account from
// ethereal.email instead of .env, and prints a link to the message there.
//
//   node scripts/smtp-check.js                  sends to SMTP_FROM using .env
//   node scripts/smtp-check.js --to you@example.org
//   node scripts/smtp-check.js --ethereal

const { values: opts } = parseArgs({
  options: {
    to: { type: 'string' },
    ethereal: { type: 'boolean', default: false },
  },
});

let transport;
let from;
if (opts.ethereal) {
  const account = await nodemailer.createTestAccount();
  transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass },
  });
  from = account.user;
} else {
  if (!env.SMTP_HOST) {
    console.error('SMTP_HOST is not set in .env. Fill in the SMTP_ keys, or run with --ethereal.');
    process.exit(1);
  }
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  from = env.SMTP_FROM;
}

const to = opts.to ?? from;
console.log(`connecting to ${transport.options.host}:${transport.options.port}`);
await transport.verify();
console.log('server accepted the connection and the login');

const info = await transport.sendMail({
  from: { name: 'Sift', address: from },
  to,
  subject: 'Sift SMTP check',
  text: `This message was sent by scripts/smtp-check.js at ${new Date().toISOString()}.`,
});
console.log(`sent, accepted for: ${info.accepted.join(', ') || 'nobody'}`);
if (opts.ethereal) console.log(`read it at: ${nodemailer.getTestMessageUrl(info)}`);
transport.close();
