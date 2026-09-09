import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { FOLDERS } from '../lib/constants.js';

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
  },
  { timestamps: true },
);

threadSchema.plugin(toJSON);

export const Thread = mongoose.model('Thread', threadSchema);
export { addressSchema };
