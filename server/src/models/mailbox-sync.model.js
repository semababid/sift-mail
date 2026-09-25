import mongoose from 'mongoose';
import { toJSON } from './plugins.js';

// How far an IMAP import has got, per mailbox: the highest UID already stored.
// The next run asks only for what came after it, so a restart picks up where
// it stopped instead of fetching the whole mailbox again.
//
// The watermark only holds while UIDVALIDITY stays the same. When the server
// changes it, every UID in the mailbox may have been renumbered, and the
// import starts over for that mailbox; the Message-ID check keeps it from
// storing what it already has.
const mailboxSyncSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    account: { type: String, required: true },
    mailbox: { type: String, required: true },
    // A 32-bit number on the wire, which imapflow hands over as a BigInt. Kept
    // as a string, which is all it is ever compared as.
    uidValidity: { type: String, required: true },
    lastUid: { type: Number, required: true, default: 0 },
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true },
);

mailboxSyncSchema.index({ userId: 1, account: 1, mailbox: 1 }, { unique: true });

mailboxSyncSchema.plugin(toJSON);

export const MailboxSync = mongoose.model('MailboxSync', mailboxSyncSchema);
