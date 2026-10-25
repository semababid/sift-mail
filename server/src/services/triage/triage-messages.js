import { Message, User } from '../../models/index.js';
import { logger } from '../../config/logger.js';
import { getAi } from '../ai/index.js';
import { classifyMessage } from './classify.js';

const log = logger.child({ worker: 'triage' });

// Received mail is what gets a bucket: the bucket says what a message asks of
// the person it came to, and their own mail asks them nothing. Received mail
// is in the inbox, or in the archive, where only the inbox moves to. Drafts,
// sent mail, spam and trash are left alone, and so is imported mail whose text
// has not arrived.
export const TRIAGE_FOLDERS = ['inbox', 'archive'];

// What the model has not looked at yet. A bucket the user chose is never
// looked at again.
export const needsTriage = () => ({
  bodyStatus: { $ne: 'pending' },
  folder: { $in: TRIAGE_FOLDERS },
  'intent.classifiedAt': null,
  'intent.source': { $ne: 'user' },
});

// Gives each of these messages a bucket, one at a time, unless it already has
// one or is not received mail. Answers how many got one, and the ids of those
// the model answered with nothing usable, which are left to be tried again.
//
// A model that cannot be reached stops the batch, rejecting with its AiError:
// every message after it would fail the same way. The error carries
// `partial`, what was done before it, since that is saved. `signal` cancels
// the message in hand.
export async function triageMessages(ids, { ai = getAi(), signal } = {}) {
  const messages = await Message.find({ _id: { $in: ids }, ...needsTriage() })
    .select('userId from to cc subject bodyText')
    // Newest first, so a backfill that stops partway has done the mail
    // someone is most likely to look at.
    .sort({ sentAt: -1, _id: -1 })
    .lean();
  if (messages.length === 0) return { classified: 0, failedIds: [] };

  const users = await User.find({ _id: { $in: [...new Set(messages.map((m) => String(m.userId)))] } })
    .select('name email')
    .lean();
  const userOf = new Map(users.map((user) => [String(user._id), user]));

  let classified = 0;
  const failedIds = [];
  for (const message of messages) {
    if (signal?.aborted) break;
    const user = userOf.get(String(message.userId));
    if (!user) continue;

    let result;
    try {
      result = await classifyMessage(message, { user, ai, signal });
    } catch (err) {
      if (err.code !== 'bad_response') throw Object.assign(err, { partial: { classified, failedIds } });
      log.warn({ messageId: String(message._id), err: err.message }, 'the model gave no usable bucket, left for the next run');
      failedIds.push(String(message._id));
      continue;
    }

    // The user may have moved the message while the model was thinking. Their
    // choice stands.
    const { modifiedCount } = await Message.updateOne(
      { _id: message._id, 'intent.source': { $ne: 'user' } },
      {
        $set: {
          intent: {
            label: result.label,
            confidence: result.confidence,
            reason: result.reason,
            model: result.model,
            source: 'model',
            classifiedAt: new Date(),
          },
        },
      },
    );
    classified += modifiedCount;
  }
  return { classified, failedIds };
}
