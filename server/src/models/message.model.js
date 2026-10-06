import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { addressSchema } from './thread.model.js';
import { FOLDERS, INTENTS, INTENT_SOURCES } from '../lib/constants.js';

const attachmentSchema = new mongoose.Schema(
  {
    // What the client names an attachment by. Its position will not do: on a
    // draft, removing one file moves every file after it.
    id: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, required: true },
    // Where the file is in storage, or null when it was not kept because it
    // was over the size limit. Never sent to the client, which gets `stored`
    // instead and downloads by id.
    storageKey: { type: String, default: null },
  },
  {
    _id: false,
    toJSON: {
      transform(doc, ret) {
        ret.stored = ret.storageKey !== null;
        delete ret.storageKey;
        return ret;
      },
    },
  },
);

const messageSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Thread', required: true },

    from: { type: addressSchema, required: true },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    bcc: { type: [addressSchema], default: [] },

    subject: { type: String, default: '' },
    bodyText: { type: String, default: '' },
    bodyHtml: { type: String, default: '' },
    // First stretch of the body, stored so a list render never loads a full one.
    snippet: { type: String, default: '' },

    folder: { type: String, enum: FOLDERS, required: true, default: 'inbox' },
    // Where the message was before it went to trash, so restoring it puts sent
    // mail back under sent instead of dropping everything into the inbox.
    trashedFrom: { type: String, enum: FOLDERS, default: null },
    isRead: { type: Boolean, default: false },
    isStarred: { type: Boolean, default: false },
    isDraft: { type: Boolean, default: false },

    sentAt: { type: Date, required: true },
    attachments: { type: [attachmentSchema], default: [] },

    // Stage 4.5. Where an imported message sits on the IMAP server: which
    // account, which folder, and its UID there. UIDs only mean anything within
    // one UIDVALIDITY, so that is kept too. Null for mail that never came in
    // over IMAP.
    imap: {
      type: new mongoose.Schema(
        {
          account: { type: String, required: true },
          mailbox: { type: String, required: true },
          uidValidity: { type: String, required: true },
          uid: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    // Imported mail is stored from its headers first and gets its body in a
    // second pass. "unavailable" means the second pass could not fetch it,
    // because the message was deleted on the server or the mailbox was reset.
    bodyStatus: { type: String, enum: ['complete', 'pending', 'unavailable'], default: 'complete' },

    // On a sent copy with recipients outside Sift: what the SMTP server said
    // when the message was handed over. Null when it never went out, either
    // because everyone on it has a Sift account or because no SMTP server is
    // configured.
    outbound: {
      type: new mongoose.Schema(
        {
          accepted: { type: [String], default: [] },
          rejected: { type: [String], default: [] },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    // RFC 5322 headers, populated from stage 4 when real mail starts arriving.
    // Threading prefers these and falls back to normalized subject when absent.
    rfcMessageId: { type: String, default: null },
    inReplyTo: { type: String, default: null },
    references: { type: [String], default: [] },

    // Stage 5. The vector lives on the message rather than in a side collection
    // so Atlas can filter by userId and return the message body in one query,
    // instead of a vector search followed by a second fetch to hydrate results.
    // Excluded from queries by default: 1,024 numbers per message would
    // otherwise ride along on every inbox list.
    embedding: { type: [Number], default: undefined, select: false },
    embeddingModel: { type: String, default: null },
    embeddedAt: { type: Date, default: null },

    // Stage 6.
    intent: {
      label: { type: String, enum: INTENTS, default: null },
      confidence: { type: Number, default: null },
      source: { type: String, enum: INTENT_SOURCES, default: 'default' },
      classifiedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

// Opening a thread: every message in it, oldest first.
messageSchema.index({ threadId: 1, sentAt: 1 });

// Message-level folder queries and unread counts.
messageSchema.index({ userId: 1, folder: 1, sentAt: -1 });

// Keyword search, and the baseline that stage 5 gets compared against. Mongo
// allows one text index per collection, so subject and body share this one.
// The userId prefix means Mongo refuses any text query that does not pin
// userId to one value, with error 291 rather than a result spanning users. An
// unscoped search fails loudly instead of leaking, the same guarantee the
// vector search gets from filtering by user.
//
// German stemming, since most of this mailbox is German: "Bewerbungen" finds
// "Bewerbung". It does not split compounds, so "Nebenkosten" still misses
// "Nebenkostenabrechnung", which is one of the gaps stage 5 is there to close.
//
// Mongo reads a field called `language` on any document in a text index as
// that document's stemming language, and refuses the write when the value is
// one it does not know. Mail headers carry values like "de-DE", so the
// override points at a field nothing sets.
messageSchema.index(
  { userId: 1, subject: 'text', bodyText: 'text' },
  {
    weights: { subject: 10, bodyText: 1 },
    name: 'message_text',
    default_language: 'german',
    language_override: 'textLanguage',
  },
);

// Ingest dedupe from stage 4. Partial, because internal mail has no RFC id and
// a plain unique index would collide on the second null.
messageSchema.index(
  { userId: 1, rfcMessageId: 1 },
  { unique: true, partialFilterExpression: { rfcMessageId: { $type: 'string' } } },
);

// Threading, when a message arrives before the one it answers: which stored
// message names this id. In-Reply-To is kept in references as well (see
// lib/headers.js), so this one index covers both headers.
messageSchema.index({ userId: 1, references: 1, sentAt: 1 });

// Stage 4.5. One stored copy per message on the IMAP server, so an import that
// runs twice over the same UIDs, after a crash between storing and saving the
// watermark, adds nothing the second time.
messageSchema.index(
  { userId: 1, 'imap.account': 1, 'imap.mailbox': 1, 'imap.uidValidity': 1, 'imap.uid': 1 },
  { unique: true, partialFilterExpression: { 'imap.uid': { $type: 'number' } }, name: 'message_imap_source' },
);

// The body pass: messages still waiting for their text, newest first.
messageSchema.index(
  { userId: 1, sentAt: -1 },
  { partialFilterExpression: { bodyStatus: 'pending' }, name: 'message_body_pending' },
);

// Stage 5 backfill: find what has not been embedded yet without scanning the
// whole collection. Only indexes the rows the backfill wants, in the order it
// walks them: newest first, with _id to settle messages that share a second,
// so each chunk can start straight after the last message of the one before.
messageSchema.index(
  { userId: 1, sentAt: -1, _id: -1 },
  { partialFilterExpression: { embeddedAt: null }, name: 'message_needs_vector' },
);

// Stage 6 bucket tabs.
messageSchema.index({ userId: 1, 'intent.label': 1, sentAt: -1 });

messageSchema.plugin(toJSON);

export const Message = mongoose.model('Message', messageSchema);
