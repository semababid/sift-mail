import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { connect, disconnect } from './helpers.js';
import { Thread, Message, Label } from '../src/models/index.js';

const userId = new mongoose.Types.ObjectId();
const threadId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connect();
  await Thread.create({ userId, lastMessageAt: new Date(), folders: ['inbox'] });
  await Message.insertMany(
    Array.from({ length: 50 }, (_, i) => ({
      userId,
      threadId,
      from: { address: 'a@b.example' },
      subject: i % 2 ? 'Kaution' : 'Rechnung',
      bodyText: 'text',
      folder: 'inbox',
      sentAt: new Date(Date.now() - i * 1000),
    })),
  );
});

afterAll(disconnect);

// Collects every stage name in a winning plan, and the first index it used.
function summarise(plan) {
  const stages = [];
  let indexName = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.stage) stages.push(node.stage);
    if (node.indexName && !indexName) indexName = node.indexName;
    for (const child of Object.values(node)) walk(child);
  };
  walk(plan);
  return { stages, indexName };
}

// A SORT stage means Mongo sorted in memory. On an inbox of ten thousand
// messages that is the difference between a list that renders and one that
// stalls, so it is asserted absent rather than just checking an index was hit.
describe.each([
  [
    'folder list',
    () => Thread.find({ userId, folders: 'inbox' }).sort({ lastMessageAt: -1, _id: -1 }),
    'userId_1_folders_1_lastMessageAt_-1__id_-1',
  ],
  [
    'folder list, second page',
    () =>
      Thread.find({
        userId,
        folders: 'inbox',
        $or: [
          { lastMessageAt: { $lt: new Date() } },
          { lastMessageAt: new Date(), _id: { $lt: new mongoose.Types.ObjectId() } },
        ],
      }).sort({ lastMessageAt: -1, _id: -1 }),
    'userId_1_folders_1_lastMessageAt_-1__id_-1',
  ],
  [
    'label filter',
    () => Thread.find({ userId, labelIds: new mongoose.Types.ObjectId() }).sort({ lastMessageAt: -1, _id: -1 }),
    'userId_1_labelIds_1_lastMessageAt_-1__id_-1',
  ],
  [
    'label view, outside trash and spam',
    () =>
      Thread.find({
        userId,
        labelIds: new mongoose.Types.ObjectId(),
        folders: { $elemMatch: { $nin: ['trash', 'spam'] } },
      }).sort({ lastMessageAt: -1, _id: -1 }),
    'userId_1_labelIds_1_lastMessageAt_-1__id_-1',
  ],
  ['opening a thread', () => Message.find({ threadId }).sort({ sentAt: 1 }), 'threadId_1_sentAt_1'],
  ['keyword search', () => Message.find({ userId, $text: { $search: 'kaution' } }), 'message_text'],
  [
    'intent bucket',
    () => Message.find({ userId, 'intent.label': 'needs_reply' }).sort({ sentAt: -1 }),
    'userId_1_intent.label_1_sentAt_-1',
  ],
  [
    'embedding backfill',
    () => Message.find({ userId, embeddedAt: null }).sort({ sentAt: -1 }),
    'message_unembedded',
  ],
])('%s', (_name, build, expectedIndex) => {
  it(`uses ${expectedIndex} and never sorts in memory`, async () => {
    const explained = await build().explain('queryPlanner');
    const { stages, indexName } = summarise(explained.queryPlanner.winningPlan);

    expect(indexName).toBe(expectedIndex);
    expect(stages).not.toContain('COLLSCAN');
    expect(stages).not.toContain('SORT');
  });
});

describe('constraints', () => {
  it('accepts mail carrying a language header without treating it as a search language', async () => {
    // Straight through the driver, since the schema would drop an unknown field.
    // Without language_override, Mongo refuses this write outright.
    const raw = mongoose.connection.db.collection('messages');
    await expect(
      raw.insertOne({ userId, threadId, subject: 'Hallo', bodyText: 'Text', language: 'de-DE' }),
    ).resolves.toBeTruthy();
  });

  const message = () => ({ userId, threadId, from: { address: 'x@y.example' }, sentAt: new Date() });

  it('rejects a duplicate RFC Message-ID for the same user', async () => {
    await Message.create({ ...message(), rfcMessageId: '<abc@mail>' });
    await expect(Message.create({ ...message(), rfcMessageId: '<abc@mail>' })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('allows any number of messages with no RFC Message-ID', async () => {
    await expect(Message.insertMany([message(), message(), message()])).resolves.toHaveLength(3);
  });

  it('lets two users own a label with the same name, but not one user twice', async () => {
    await Label.create({ userId, name: 'Uni' });
    await expect(Label.create({ userId: new mongoose.Types.ObjectId(), name: 'Uni' })).resolves.toBeTruthy();
    await expect(Label.create({ userId, name: 'Uni' })).rejects.toMatchObject({ code: 11000 });
  });
});
