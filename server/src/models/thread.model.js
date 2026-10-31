import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { FOLDERS, INTENTS } from '../lib/constants.js';

const addressSchema = new mongoose.Schema(
  { name: String, address: { type: String, required: true, lowercase: true, trim: true } },
  { _id: false },
);

// Threads get their own collection rather than being assembled from messages at
// query time. The inbox list is read far more often than mail arrives, so the
// cost belongs on the write: one document per conversation, already carrying the
// snippet and counters the list needs, means rendering a folder is a single
// find with no aggregation or lookup.
//
// One thread document per user per conversation. Two Sift users in the same
// exchange each get their own, because folder, read state and labels are all
// per-person and sharing the document would mean filtering them on every read.
const threadSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    subject: { type: String, default: '' },
    // Lowercased subject with any Re:/Fwd: prefixes stripped. Stage 4 falls back
    // to this when a message arrives with no References header, which is common.
    normalizedSubject: { type: String, default: '' },
    participants: { type: [addressSchema], default: [] },

    snippet: { type: String, default: '' },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, required: true },

    // Denormalised from the messages so a folder list never has to touch them.
    folders: { type: [String], enum: FOLDERS, default: [] },
    hasUnread: { type: Boolean, default: true },
    isStarred: { type: Boolean, default: false },
    labelIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Label', default: [] },

    // Stage 6. The conversation's triage bucket and who chose it, the model or
    // the user, worked out by refreshThread from its messages. Null until one
    // of its received messages has a bucket.
    bucket: { type: String, enum: INTENTS, default: null },
    bucketSource: { type: String, enum: ['model', 'user'], default: null },
  },
  { timestamps: true },
);

// Index order follows equality, then sort. userId is on every query because a
// thread lookup that is not scoped to one user is a bug.

// The folder list: find({ userId, folders }).sort({ lastMessageAt: -1, _id: -1 }).
// _id is the tiebreak. Threads often share a timestamp to the second, and a
// cursor on lastMessageAt alone skips or repeats them at a page boundary.
threadSchema.index({ userId: 1, folders: 1, lastMessageAt: -1, _id: -1 });

// Same list filtered to one label.
threadSchema.index({ userId: 1, labelIds: 1, lastMessageAt: -1, _id: -1 });

// A bucket tab: one folder, one bucket, newest first.
threadSchema.index({ userId: 1, folders: 1, bucket: 1, lastMessageAt: -1, _id: -1 });

// The subject fallback above, used when grouping an incoming message.
threadSchema.index({ userId: 1, normalizedSubject: 1, lastMessageAt: -1 });

threadSchema.plugin(toJSON);

export const Thread = mongoose.model('Thread', threadSchema);
export { addressSchema };
