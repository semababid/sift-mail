import { IntentLabel, Message } from '../../models/index.js';

// The feedback loop. Every time the user puts a conversation in a bucket, the
// message that decided it is stored with the bucket they chose. When the
// classifier sorts a new message, it is shown the few of those that are most
// like it, as examples of how this person sorts their mail. Nothing is
// retrained; the examples are in the prompt.
//
// "Most like it" is two things. Mostly it is what the message says, as the
// vectors compare it. But a mailing list sends one kind of mail about many
// things: job alerts from one address are each about a different job, and
// their vectors are far apart (a median of 0.57 for 38 alerts in the dev
// mailbox, below the floor). So mail from the same list counts as alike too,
// however far apart the vectors are.

// How many examples the classifier is shown at most. Each one is another
// email in the prompt, so a few seconds more per message on a laptop.
export const EXAMPLES = 4;

// How alike two messages have to be, as the dot product of their vectors, for
// a correction to be worth showing. Measured on the dev mailbox in stage 6.4,
// over every pair of received messages from different conversations: below
// 0.7, two messages were in the same bucket about 30% of the time, which is
// what chance gives with buckets of these sizes. From 0.7 to 0.8 it was 71%,
// and above 0.8, 98%. An example less alike than this tells the model nothing
// about the message, and can still pull it towards the example's bucket.
export const MIN_SIMILARITY = 0.7;

// How many corrections are weighed, the newest first. One person moving their
// own mail stays well under this for a long time, and while they do, reading
// every vector and comparing them here is exact and quicker than a round trip
// to a vector index. Past it, the oldest corrections stop counting.
export const MAX_CORRECTIONS = 500;

// Stores the user's choice of bucket for these messages, replacing any choice
// they made for them before. A move that agrees with the model is stored too:
// it says the model was right about mail like this, and that is as worth
// showing the model as a mistake is.
export async function recordCorrections(userId, messageIds, label) {
  if (messageIds.length === 0) return;
  await IntentLabel.bulkWrite(
    messageIds.map((messageId) => ({
      updateOne: {
        filter: { messageId, source: 'user' },
        update: { $set: { userId, label } },
        upsert: true,
      },
    })),
  );
}

// Takes the user's choice back, as when they undo a move or let Sift choose
// again. What the seeder knew about the message stays.
export async function withdrawCorrections(userId, messageIds) {
  if (messageIds.length === 0) return;
  await IntentLabel.deleteMany({ userId, messageId: { $in: messageIds }, source: 'user' });
}

// The user's corrections that can be compared with a vector from `model`:
// { messageId, threadId, label, vector, from, bulk } for each, newest first.
// A corrected message without a vector from that model cannot be compared,
// and is left out until the embedding backfill gives it one.
export async function loadCorrections(userId, { model, limit = MAX_CORRECTIONS } = {}) {
  const labels = await IntentLabel.find({ userId, source: 'user' })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select('messageId label')
    .lean();
  if (labels.length === 0) return [];

  const messages = await Message.find({ _id: { $in: labels.map((l) => l.messageId) }, userId, embeddingModel: model })
    .select('+embedding threadId from bulk')
    .lean();
  const byId = new Map(messages.filter((m) => m.embedding?.length).map((m) => [String(m._id), m]));
  return labels.flatMap(({ messageId, label }) => {
    const message = byId.get(String(messageId));
    if (!message) return [];
    const { threadId, embedding: vector, from, bulk } = message;
    return [{ messageId: message._id, threadId, label, vector, from, bulk }];
  });
}

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
};

// Whether two messages came from the same mailing list. List-Id would say so
// best, but most lists send none, and one company can send under two (Indeed
// does), so it is the sender's address. Only for list mail: a person writes
// every kind of mail from one address. In the seeded mail, two messages from
// the same person but further apart than the floor were in the same bucket
// 29% of the time, no better than chance.
const sameList = (a, b) =>
  a.bulk === true && b.bulk === true && a.from?.address?.toLowerCase() === b.from?.address?.toLowerCase();

// The corrections nearest `message`, with how alike each is: those from the
// list it came from first, then the rest whose vectors are close enough, most
// alike first. Every vector is of length 1, so the dot product is the cosine.
//
// Corrections from the message's own conversation are left out. A
// conversation moves between buckets as it goes on, so what the user said
// about an earlier message there is no guide to what the next one asks.
export function nearestCorrections(message, corrections, { k = EXAMPLES, minSimilarity = MIN_SIMILARITY } = {}) {
  return corrections
    .filter((c) => String(c.threadId) !== String(message.threadId) && String(c.messageId) !== String(message._id))
    .map((c) => ({ ...c, sameList: sameList(message, c), similarity: message.vector ? dot(message.vector, c.vector) : null }))
    .filter((c) => c.sameList || c.similarity >= minSimilarity)
    .sort((a, b) => b.sameList - a.sameList || b.similarity - a.similarity)
    .slice(0, k);
}

// The examples to show the classifier for these corrections: each message as
// the model reads mail, with the bucket the user chose. In the order given.
export async function examplesFrom(corrections) {
  if (corrections.length === 0) return [];
  const messages = await Message.find({ _id: { $in: corrections.map((c) => c.messageId) } })
    .select('from to cc subject bodyText bulk listName')
    .lean();
  const byId = new Map(messages.map((m) => [String(m._id), m]));
  return corrections.flatMap((c) => {
    const message = byId.get(String(c.messageId));
    return message ? [{ message, label: c.label }] : [];
  });
}
