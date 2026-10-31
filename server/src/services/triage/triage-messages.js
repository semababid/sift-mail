import { Message, User } from '../../models/index.js';
import { TRIAGE_FOLDERS } from '../../lib/constants.js';
import { refreshThread } from '../thread-summary.js';
import { logger } from '../../config/logger.js';
import { getAi } from '../ai/index.js';
import { embedMessages } from '../embedding/embed-messages.js';
import { classifyMessage } from './classify.js';
import { examplesFrom, loadCorrections, nearestCorrections } from './corrections.js';

const log = logger.child({ worker: 'triage' });

// What the model has not looked at yet: received mail, in TRIAGE_FOLDERS, with
// its text. Drafts, sent mail, spam and trash are left alone. A bucket the
// user chose is never looked at again.
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
// Where the user has corrected the model before, each message is shown with
// the corrections most like it as examples, and their ids are kept with the
// bucket. Finding them takes the message's vector, so one that has none yet
// is embedded first. A user with no corrections costs no embedding.
//
// A model that cannot be reached stops the batch, rejecting with its AiError:
// every message after it would fail the same way. The error carries
// `partial`, what was done before it, since that is saved. `signal` cancels
// the message in hand.
export async function triageMessages(ids, { ai = getAi(), signal } = {}) {
  const messages = await Message.find({ _id: { $in: ids }, ...needsTriage() })
    .select('userId threadId from to cc subject bodyText bulk listName embeddingModel +embedding')
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
  const stopped = (err) => Object.assign(err, { partial: { classified, failedIds } });

  // Each user's corrections, and a vector for every message of a user who
  // has any.
  const model = ai.embeddingModel;
  const correctionsOf = new Map();
  try {
    for (const user of users) correctionsOf.set(String(user._id), await loadCorrections(user._id, { model }));
    const unembedded = messages.filter(
      (m) => correctionsOf.get(String(m.userId))?.length && (m.embeddingModel !== model || !m.embedding?.length),
    );
    if (unembedded.length > 0) {
      await embedMessages(unembedded.map((m) => m._id), { ai });
      const vectors = await Message.find({ _id: { $in: unembedded.map((m) => m._id) }, embeddingModel: model })
        .select('+embedding')
        .lean();
      const vectorOf = new Map(vectors.map((v) => [String(v._id), v.embedding]));
      for (const m of unembedded) m.embedding = vectorOf.get(String(m._id));
    }
  } catch (err) {
    throw stopped(err);
  }

  for (const message of messages) {
    if (signal?.aborted) break;
    const user = userOf.get(String(message.userId));
    if (!user) continue;

    let result;
    let examples = [];
    try {
      const corrections = correctionsOf.get(String(message.userId));
      if (corrections.length > 0) {
        examples = await examplesFrom(nearestCorrections({ ...message, vector: message.embedding }, corrections));
      }
      result = await classifyMessage(message, { user, examples, ai, signal });
    } catch (err) {
      if (err.code !== 'bad_response') throw stopped(err);
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
            modelLabel: result.label,
            confidence: result.confidence,
            reason: result.reason,
            model: result.model,
            source: 'model',
            examples: examples.map((e) => e.message._id),
            classifiedAt: new Date(),
          },
        },
      },
    );
    classified += modifiedCount;
    // The conversation's bucket comes from its messages'.
    if (modifiedCount) await refreshThread(message.threadId);
  }
  return { classified, failedIds };
}
