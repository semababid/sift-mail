import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { INTENTS } from '../lib/constants.js';

// What a message's triage bucket really is, as opposed to what the classifier
// guessed. Two sources: the seeder, which knows the bucket it wrote each
// conversation for, and the user, who moves a conversation to a bucket in the
// inbox (stage 6.3). The user's are the corrections the classifier is shown
// as examples (stage 6.4), and both are what the evaluation scores against,
// which is why they share a collection.
//
// A message can have one of each. Taking a move back deletes the user's
// label, and the seed's has to still be there afterwards.
const intentLabelSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    label: { type: String, enum: INTENTS, required: true },
    source: { type: String, enum: ['seed', 'user'], required: true },
  },
  { timestamps: true },
);

intentLabelSchema.index({ messageId: 1, source: 1 }, { unique: true });

// A user's corrections, newest first, which is the order the classifier
// loads them in.
intentLabelSchema.index({ userId: 1, source: 1, updatedAt: -1 });

intentLabelSchema.plugin(toJSON);

export const IntentLabel = mongoose.model('IntentLabel', intentLabelSchema);
