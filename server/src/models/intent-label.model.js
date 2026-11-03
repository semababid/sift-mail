import mongoose from 'mongoose';
import { toJSON } from './plugins.js';
import { INTENTS } from '../lib/constants.js';

// What a message's triage bucket really is, as opposed to what the classifier
// guessed. Three sources:
//   seed  the bucket the seeder wrote each conversation for
//   user  a move in the inbox (stage 6.3), which the classifier is shown as
//         an example from then on (stage 6.4)
//   eval  a label given by hand for the evaluation (stage 6.5), one message
//         at a time. The seeder's buckets are per conversation, and wrong for
//         some of its messages, so they are not what accuracy is scored on.
//
// A message can have one of each. Taking a move back deletes the user's
// label, and the others have to still be there afterwards.
function needsLabel() {
  return !(this.source === 'eval' && this.skipped);
}

const intentLabelSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    // Required, except on an eval label for a message that was skipped,
    // which is kept so the labeller does not offer it again.
    label: { type: String, enum: INTENTS, required: [needsLabel, 'a label needs a bucket unless it was skipped'] },
    source: { type: String, enum: ['seed', 'user', 'eval'], required: true },
    skipped: { type: Boolean, default: undefined },
  },
  { timestamps: true },
);

intentLabelSchema.index({ messageId: 1, source: 1 }, { unique: true });

// A user's corrections, newest first, which is the order the classifier
// loads them in.
intentLabelSchema.index({ userId: 1, source: 1, updatedAt: -1 });

intentLabelSchema.plugin(toJSON);

export const IntentLabel = mongoose.model('IntentLabel', intentLabelSchema);
