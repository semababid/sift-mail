import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { IntentLabel, Message, Thread } from '../src/models/index.js';
import { EMBEDDING_DIMS } from '../src/lib/constants.js';
import { setAi } from '../src/services/ai/index.js';
import { refreshThread } from '../src/services/thread-summary.js';
import { triageMessages } from '../src/services/triage/triage-messages.js';
import { flushTriage } from '../src/services/triage/queue.js';
import { flushEmbeddings } from '../src/services/embedding/queue.js';
import { triagePrompt } from '../src/services/triage/classify.js';
import {
  EXAMPLES,
  loadCorrections,
  MIN_SIMILARITY,
  nearestCorrections,
  recordCorrections,
} from '../src/services/triage/corrections.js';
import { fakeAi } from './fake-ai.js';

const app = createApp();

beforeAll(connect);
afterAll(async () => {
  setAi(undefined);
  await disconnect();
});

let me;
let ai;
beforeEach(async () => {
  await flushTriage();
  await flushEmbeddings();
  await clearDb();
  ai = fakeAi();
  setAi(ai);
  me = await signIn(app);
});

// Unit vectors whose dot products are known: axis(i) is the i-th axis, and
// towards(i, similarity) has that dot product with axis(0) and is otherwise
// along axis i, so two of them with different i are as alike as their
// similarities multiplied.
const axis = (i) => Array.from({ length: EMBEDDING_DIMS }, (_, j) => (j === i ? 1 : 0));
const towards = (i, similarity) =>
  Array.from({ length: EMBEDDING_DIMS }, (_, j) => (j === 0 ? similarity : j === i ? Math.sqrt(1 - similarity ** 2) : 0));

const MARA = { name: 'Mara', address: 'mara@elsewhere.example' };
const T0 = Date.UTC(2026, 4, 1);

// One received message in a conversation of its own, with the vector given,
// as the fake model would have embedded it.
let minute = 0;
async function received({ vector, subject = 'Nachricht', userId = me.user._id, model = ai.embeddingModel, ...rest } = {}) {
  const thread = await Thread.create({ userId, subject, lastMessageAt: new Date(T0) });
  minute += 1;
  const [message] = await Message.insertMany([
    {
      userId,
      threadId: thread._id,
      from: MARA,
      to: [{ address: 'semab@sift.example' }],
      subject,
      bodyText: `${subject}, Text`,
      folder: 'inbox',
      sentAt: new Date(T0 + minute * 60_000),
      ...(vector && { embedding: vector, embeddingModel: model, embeddedAt: new Date() }),
      ...rest,
    },
  ]);
  await refreshThread(thread._id);
  return message;
}

const batch = (body) => request(app).post('/api/threads/batch').set('Cookie', me.cookie).send(body);
const userLabels = () => IntentLabel.find({ source: 'user' }).lean();

describe('storing corrections', () => {
  it('stores the bucket the user moves a conversation to, against the message that decides it', async () => {
    const message = await received();
    expect((await batch({ ids: [String(message.threadId)], action: 'setBucket', bucket: 'needs_reply' })).status).toBe(200);
    expect(await userLabels()).toMatchObject([{ messageId: message._id, label: 'needs_reply', userId: message.userId }]);
  });

  it('keeps one correction per message, the latest', async () => {
    const message = await received();
    await batch({ ids: [String(message.threadId)], action: 'setBucket', bucket: 'needs_reply' });
    await batch({ ids: [String(message.threadId)], action: 'setBucket', bucket: 'do_at_a_time' });
    expect(await userLabels()).toMatchObject([{ messageId: message._id, label: 'do_at_a_time' }]);
  });

  it('drops the correction when the move is taken back', async () => {
    const message = await received({ intent: { label: 'read_only', modelLabel: 'read_only', source: 'model' } });
    await batch({ ids: [String(message.threadId)], action: 'setBucket', bucket: 'needs_reply' });
    await batch({ ids: [String(message.threadId)], action: 'resetBucket' });
    expect(await userLabels()).toEqual([]);
  });

  it('keeps what the seeder knew about the message through a move and its undoing', async () => {
    const message = await received();
    await IntentLabel.create({ userId: message.userId, messageId: message._id, label: 'read_only', source: 'seed' });
    await batch({ ids: [String(message.threadId)], action: 'setBucket', bucket: 'needs_reply' });
    expect(await IntentLabel.countDocuments({ messageId: message._id })).toBe(2);
    await batch({ ids: [String(message.threadId)], action: 'resetBucket' });
    expect(await IntentLabel.find({ messageId: message._id }).lean()).toMatchObject([{ label: 'read_only', source: 'seed' }]);
  });

  it('stores nothing for someone else’s conversation', async () => {
    const theirs = await received({ userId: new mongoose.Types.ObjectId() });
    await batch({ ids: [String(theirs.threadId)], action: 'setBucket', bucket: 'needs_reply' });
    expect(await userLabels()).toEqual([]);
  });
});

describe('loading corrections', () => {
  it('loads the user’s own, newest first, with a vector from the model asked about', async () => {
    const older = await received({ vector: axis(1) });
    const newer = await received({ vector: axis(2) });
    const otherModel = await received({ vector: axis(3), model: 'another/embedder' });
    const noVector = await received();
    const seeded = await received({ vector: axis(4) });
    const theirs = await received({ vector: axis(5), userId: new mongoose.Types.ObjectId() });

    await recordCorrections(me.user._id, [older._id], 'needs_reply');
    await recordCorrections(me.user._id, [newer._id, otherModel._id, noVector._id], 'do_at_a_time');
    await recordCorrections(theirs.userId, [theirs._id], 'read_only');
    await IntentLabel.create({ userId: me.user._id, messageId: seeded._id, label: 'read_only', source: 'seed' });
    // Corrections made in the same millisecond would have no order.
    await IntentLabel.updateOne({ messageId: older._id }, { $set: { updatedAt: new Date(T0) } }, { timestamps: false });

    const corrections = await loadCorrections(me.user._id, { model: ai.embeddingModel });
    expect(corrections.map((c) => [String(c.messageId), c.label])).toEqual([
      [String(newer._id), 'do_at_a_time'],
      [String(older._id), 'needs_reply'],
    ]);
    expect(corrections[0]).toMatchObject({ threadId: newer.threadId, vector: axis(2) });
  });

  it('stops at the limit, keeping the newest', async () => {
    const messages = [await received({ vector: axis(1) }), await received({ vector: axis(2) })];
    await recordCorrections(me.user._id, [messages[0]._id], 'needs_reply');
    await IntentLabel.updateOne({ messageId: messages[0]._id }, { $set: { updatedAt: new Date(T0) } }, { timestamps: false });
    await recordCorrections(me.user._id, [messages[1]._id], 'read_only');
    const corrections = await loadCorrections(me.user._id, { model: ai.embeddingModel, limit: 1 });
    expect(corrections.map((c) => c.label)).toEqual(['read_only']);
  });
});

describe('picking the nearest corrections', () => {
  const message = { _id: 'm', threadId: 't', vector: axis(0) };
  const correction = (i, similarity, fields = {}) => ({
    messageId: `c${i}`,
    threadId: `t${i}`,
    label: 'read_only',
    vector: towards(i, similarity),
    ...fields,
  });

  it('takes the most alike first, as many as it shows', async () => {
    const corrections = [0.75, 0.95, 0.8, 0.9, 0.85].map((s, i) => correction(i + 1, s));
    const nearest = nearestCorrections(message, corrections);
    expect(nearest).toHaveLength(EXAMPLES);
    expect(nearest.map((c) => c.similarity.toFixed(2))).toEqual(['0.95', '0.90', '0.85', '0.80']);
  });

  it('leaves out corrections too little like the message to say anything about it', async () => {
    const nearest = nearestCorrections(message, [correction(1, MIN_SIMILARITY - 0.01), correction(2, MIN_SIMILARITY)]);
    expect(nearest.map((c) => c.messageId)).toEqual(['c2']);
  });

  it('leaves out the message itself and any correction from its own conversation', async () => {
    const nearest = nearestCorrections(message, [
      correction(1, 0.99, { threadId: 't' }),
      correction(2, 1, { messageId: 'm' }),
      correction(3, 0.9),
    ]);
    expect(nearest.map((c) => c.messageId)).toEqual(['c3']);
  });

  it('finds nothing by vector for a message without one', async () => {
    expect(nearestCorrections({ ...message, vector: undefined }, [correction(1, 0.99)])).toEqual([]);
  });

  describe('for mail from a mailing list', () => {
    const alerts = { address: 'alerts@jobs.example' };
    const listMail = { ...message, from: alerts, bulk: true };

    it('counts mail from the same list as alike however far apart, and puts it first', async () => {
      const nearest = nearestCorrections(listMail, [
        correction(1, 0.95),
        correction(2, 0.3, { from: { address: 'Alerts@Jobs.example' }, bulk: true }),
        correction(3, 0.5, { from: alerts, bulk: true }),
      ]);
      expect(nearest.map((c) => c.messageId)).toEqual(['c3', 'c2', 'c1']);
    });

    it('finds it for a message without a vector too', async () => {
      const nearest = nearestCorrections({ ...listMail, vector: undefined }, [correction(1, 0.3, { from: alerts, bulk: true })]);
      expect(nearest.map((c) => c.messageId)).toEqual(['c1']);
    });

    it('does not count a person’s mail as alike only because it came from the same address', async () => {
      const mara = { address: 'mara@elsewhere.example' };
      const nearest = nearestCorrections({ ...message, from: mara, bulk: false }, [
        correction(1, 0.3, { from: mara, bulk: false }),
        correction(2, 0.3, { from: mara, bulk: true }),
        correction(3, 0.3, { from: mara, bulk: null }),
      ]);
      expect(nearest).toEqual([]);
      expect(nearestCorrections({ ...message, from: mara, bulk: true }, [correction(1, 0.3, { from: mara, bulk: false })])).toEqual([]);
    });
  });
});

describe('sorting with corrections', () => {
  const user = () => ({ name: 'Semab', email: me.user.email });

  it('sorts zero-shot, without embedding anything, for a user who has corrected nothing', async () => {
    const message = await received({ subject: 'Neu' });
    expect(await triageMessages([message._id], { ai })).toMatchObject({ classified: 1 });
    expect(ai.asked[0].system).toBe(triagePrompt(user()));
    expect(ai.asked[0].messages[0].content).not.toContain('<example>');
    expect(ai.calls).toEqual([]);
    expect((await Message.findById(message._id).lean()).intent.examples).toEqual([]);
  });

  it('shows the model the user’s nearest corrections as examples, and keeps which they were', async () => {
    const far = await received({ subject: 'Weit weg', vector: towards(1, MIN_SIMILARITY - 0.1) });
    const near = await received({ subject: 'Fast gleich', vector: towards(2, 0.95) });
    const nearer = await received({ subject: 'Gleich', vector: towards(3, 0.99) });
    const theirs = await received({ subject: 'Fremd', vector: towards(4, 1), userId: new mongoose.Types.ObjectId() });
    await recordCorrections(me.user._id, [far._id, near._id], 'do_at_a_time');
    await recordCorrections(me.user._id, [nearer._id], 'needs_reply');
    await recordCorrections(theirs.userId, [theirs._id], 'read_only');

    const message = await received({ subject: 'Neu', vector: axis(0) });
    await triageMessages([message._id], { ai });

    expect(ai.asked[0].system).toBe(triagePrompt(user(), { examples: true }));
    expect(ai.asked[0].system).toContain('<example>');
    const asked = ai.asked[0].messages[0].content;
    const examples = asked.match(/<example>[\s\S]*?<\/example>/g);
    expect(examples).toHaveLength(2);
    expect(examples[0]).toContain('Subject: Gleich');
    expect(examples[0]).toContain('Sorted by hand into: needs_reply');
    expect(examples[1]).toContain('Subject: Fast gleich');
    expect(examples[1]).toContain('Sorted by hand into: do_at_a_time');
    // The message to sort comes last, after the examples.
    expect(asked.endsWith('</example>\n\n<email>\nFrom: Mara <mara@elsewhere.example>\nTo: semab@sift.example\nSubject: Neu\n\nNeu, Text\n</email>')).toBe(true);
    expect(asked).not.toContain('Weit weg');
    expect(asked).not.toContain('Fremd');

    const { intent } = await Message.findById(message._id).lean();
    expect(intent.examples.map(String)).toEqual([String(nearer._id), String(near._id)]);
  });

  it('gives a message its vector first when it has none yet, and stores it', async () => {
    const message = await received({ subject: 'Neu' });
    // A correction exactly like the message is, once the fake model embeds it.
    const twin = await received({ subject: 'Zwilling', vector: (await ai.embed(['Neu\n\nNeu, Text']))[0] });
    ai.calls.length = 0;
    await recordCorrections(me.user._id, [twin._id], 'waiting_on_them');

    await triageMessages([message._id], { ai });
    expect(ai.calls).toHaveLength(1);
    expect(ai.asked[0].messages[0].content).toContain('Sorted by hand into: waiting_on_them');
    const stored = await Message.findById(message._id).select('+embedding').lean();
    expect(stored).toMatchObject({ embeddingModel: ai.embeddingModel, embedding: twin.embedding });
    expect(stored.intent.examples.map(String)).toEqual([String(twin._id)]);
  });

  it('shows mail from the same list whatever it is about', async () => {
    const alerts = { name: 'Jobs', address: 'alerts@jobs.example' };
    const alert = await received({ subject: 'Werkstudent Data', vector: towards(1, 0.4), from: alerts, bulk: true });
    const unrelated = await received({ subject: 'Anderes', vector: towards(2, 0.4) });
    await recordCorrections(me.user._id, [alert._id], 'do_at_a_time');
    await recordCorrections(me.user._id, [unrelated._id], 'needs_reply');

    const next = await received({ subject: 'Werkstudent Design', vector: axis(0), from: alerts, bulk: true });
    await triageMessages([next._id], { ai });
    const asked = ai.asked[0].messages[0].content;
    expect(asked).toContain('Subject: Werkstudent Data\n');
    expect(asked).not.toContain('Anderes');
  });

  it('compares only vectors from the model in use', async () => {
    const old = await received({ subject: 'Alt', vector: axis(0), model: 'another/embedder' });
    await recordCorrections(me.user._id, [old._id], 'needs_reply');
    const message = await received({ subject: 'Neu', vector: axis(0) });
    await triageMessages([message._id], { ai });
    expect(ai.asked[0].messages[0].content).not.toContain('<example>');
  });

  it('stops before sorting anything when the message cannot be embedded, to be tried again', async () => {
    const corrected = await received({ subject: 'Alt', vector: axis(0) });
    await recordCorrections(me.user._id, [corrected._id], 'needs_reply');
    const message = await received({ subject: 'Neu' });
    ai.state.fail = 'unavailable';

    const err = await triageMessages([message._id], { ai }).catch((error) => error);
    expect(err).toMatchObject({ code: 'unavailable', partial: { classified: 0, failedIds: [] } });
    expect(ai.asked).toEqual([]);
    expect((await Message.findById(message._id).lean()).intent.classifiedAt).toBeNull();
  });

  it('learns from a move straight away: the next message like it is sorted with it in view', async () => {
    const first = await received({ subject: 'Rabatt', vector: towards(1, 0.9) });
    await batch({ ids: [String(first.threadId)], action: 'setBucket', bucket: 'read_only' });

    const next = await received({ subject: 'Noch mehr Rabatt', vector: axis(0) });
    await triageMessages([next._id], { ai });
    expect(ai.asked[0].messages[0].content).toContain('Subject: Rabatt\n');
  });
});
