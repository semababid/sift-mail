import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { INTENTS } from '../lib/constants.js';

// What a message's triage bucket really is, as opposed to what the classifier
// guessed. Two sources: the seeder, which knows the bucket it wrote each
// conversation for, and later the user, when they drag a message to a
// different bucket in stage 6. Both feed the same evaluation and the same
// few-shot examples, which is why they share a collection.
const intentLabelSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true, unique: true },
    label: { type: String, enum: INTENTS, required: true },
    source: { type: String, enum: ['seed', 'user'], required: true },
  },
  { timestamps: true },
);

intentLabelSchema.index({ userId: 1, source: 1 });

intentLabelSchema.plugin(toJSON);

export const IntentLabel = mongoose.model('IntentLabel', intentLabelSchema);
