import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { addressSchema } from './thread.model.js';
import { FOLDERS, INTENTS, INTENT_SOURCES } from '../lib/constants.js';

const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    contentType: String,
    size: Number,
    storageKey: { type: String, required: true },
  },
  { _id: false },
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
    isRead: { type: Boolean, default: false },
    isStarred: { type: Boolean, default: false },
    isDraft: { type: Boolean, default: false },

    sentAt: { type: Date, required: true },
    attachments: { type: [attachmentSchema], default: [] },

    // RFC 5322 headers, populated from stage 4 when real mail starts arriving.
    // Threading prefers these and falls back to normalized subject when absent.
    rfcMessageId: { type: String, default: null },
    inReplyTo: { type: String, default: null },
    references: { type: [String], default: [] },

    // Stage 5. The vector lives on the message rather than in a side collection
    // so Atlas can filter by userId and return the message body in one query,
    // instead of a vector search followed by a second fetch to hydrate results.
    // Excluded from queries by default: 768 floats per document would otherwise
    // ride along on every inbox list.
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
// The userId prefix means a text query has to name a user to use the index,
// which is the same argument as filtering the vector search by user.
messageSchema.index(
  { userId: 1, subject: 'text', bodyText: 'text' },
  { weights: { subject: 10, bodyText: 1 }, name: 'message_text' },
);

// Ingest dedupe from stage 4. Partial, because internal mail has no RFC id and
// a plain unique index would collide on the second null.
messageSchema.index(
  { userId: 1, rfcMessageId: 1 },
  { unique: true, partialFilterExpression: { rfcMessageId: { $type: 'string' } } },
);

// Stage 5 backfill: find what has not been embedded yet without scanning the
// whole collection. Only indexes the rows the backfill actually wants.
messageSchema.index(
  { userId: 1, sentAt: -1 },
  { partialFilterExpression: { embeddedAt: null }, name: 'message_unembedded' },
);

// Stage 6 bucket tabs.
messageSchema.index({ userId: 1, 'intent.label': 1, sentAt: -1 });

messageSchema.plugin(toJSON);

export const Message = mongoose.model('Message', messageSchema);
