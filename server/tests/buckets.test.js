import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { Message, Thread } from '../src/models/index.js';
import { setAi } from '../src/services/ai/index.js';
import { refreshThread } from '../src/services/thread-summary.js';
import { triageMessages } from '../src/services/triage/triage-messages.js';
import { flushTriage } from '../src/services/triage/queue.js';
import { fakeAi } from './fake-ai.js';

const app = createApp();

beforeAll(connect);
afterAll(async () => {
  setAi(undefined);
  await disconnect();
});

const MARA = { name: 'Mara', address: 'mara@elsewhere.example' };
const T0 = Date.UTC(2026, 4, 1);

let me;
let ai;
beforeEach(async () => {
  await flushTriage();
  await clearDb();
  ai = fakeAi();
  setAi(ai);
  me = await signIn(app);
});

const self = () => ({ name: 'Semab', address: me.user.email });

// A conversation of `messages`, each { from: 'them' | 'me', intent, minute },
// stored with its summary built. Received mail is in the inbox, mine in sent.
async function conversation(messages, { userId = me.user._id, subject = 'Wohnung' } = {}) {
  const thread = await Thread.create({ userId, subject, lastMessageAt: new Date(T0) });
  await Message.insertMany(
    messages.map(({ from = 'them', intent, minute = 0, ...rest }, i) => ({
      userId,
      threadId: thread._id,
      from: from === 'them' ? MARA : self(),
      to: [from === 'them' ? self() : MARA],
      subject,
      bodyText: `Nachricht ${i}`,
      folder: from === 'them' ? 'inbox' : 'sent',
      sentAt: new Date(T0 + (minute || i) * 60_000),
      ...(intent && { intent: { classifiedAt: new Date(T0), ...intent } }),
      ...rest,
    })),
  );
  return refreshThread(thread._id);
}
const model = (label) => ({ label, modelLabel: label, source: 'model' });
const user = (label, modelLabel = null) => ({ label, modelLabel, source: 'user' });

const batch = (body) => request(app).post('/api/threads/batch').set('Cookie', me.cookie).send(body);
const list = (query) => request(app).get('/api/threads').query(query).set('Cookie', me.cookie);
const reload = async (thread) => Thread.findById(thread._id).lean();
const newestReceived = async (thread) =>
  (await Message.find({ threadId: thread._id, folder: 'inbox' }).sort({ sentAt: -1 }).limit(1).lean())[0];

describe('a conversation’s bucket', () => {
  it('is that of its newest received message with one', async () => {
    const thread = await conversation([
      { intent: model('do_at_a_time') },
      { intent: model('read_only') },
      // Not sorted yet: the one before it still decides.
      {},
    ]);
    expect(thread).toMatchObject({ bucket: 'read_only', bucketSource: 'model' });
  });

  it('is none until a received message has one, and for a conversation of only sent mail', async () => {
    expect(await conversation([{}])).toMatchObject({ bucket: null, bucketSource: null });
    expect(await conversation([{ from: 'me', intent: model('needs_reply') }])).toMatchObject({ bucket: null });
  });

  it('turns from needs a reply to waiting once its owner has replied', async () => {
    const thread = await conversation([{ intent: model('needs_reply') }, { from: 'me' }]);
    expect(thread).toMatchObject({ bucket: 'waiting_on_them', bucketSource: 'model' });
  });

  it('keeps needs a reply when the reply came before the question, or is still a draft', async () => {
    expect(await conversation([{ from: 'me' }, { intent: model('needs_reply') }])).toMatchObject({ bucket: 'needs_reply' });
    expect(
      await conversation([{ intent: model('needs_reply') }, { from: 'me', isDraft: true, folder: 'drafts' }]),
    ).toMatchObject({ bucket: 'needs_reply' });
  });

  it('is the user’s choice as they made it, replied to or not', async () => {
    const thread = await conversation([{ intent: user('needs_reply', 'read_only') }, { from: 'me' }]);
    expect(thread).toMatchObject({ bucket: 'needs_reply', bucketSource: 'user' });
  });

  it('comes from the archive too, but not from trash or spam', async () => {
    expect(await conversation([{ intent: model('read_only'), folder: 'archive' }])).toMatchObject({ bucket: 'read_only' });
    expect(await conversation([{ intent: model('read_only'), folder: 'trash' }])).toMatchObject({ bucket: null });
  });

  it('is set as soon as the model sorts a message', async () => {
    const thread = await conversation([{}]);
    ai.state.bucket = () => 'needs_reply';
    await triageMessages([(await newestReceived(thread))._id]);
    expect(await reload(thread)).toMatchObject({ bucket: 'needs_reply', bucketSource: 'model' });
    expect(await newestReceived(thread)).toMatchObject({ intent: { label: 'needs_reply', modelLabel: 'needs_reply' } });
  });
});

describe('listing one bucket', () => {
  it('shows only the conversations in it, newest first, with their bucket', async () => {
    const older = await conversation([{ intent: model('needs_reply'), minute: 1 }], { subject: 'Älter' });
    await conversation([{ intent: model('read_only'), minute: 2 }], { subject: 'Newsletter' });
    const newer = await conversation([{ intent: model('needs_reply'), minute: 3 }], { subject: 'Neuer' });

    const res = await list({ folder: 'inbox', bucket: 'needs_reply' });
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t) => t.id)).toEqual([String(newer._id), String(older._id)]);
    expect(res.body.threads[0]).toMatchObject({ bucket: 'needs_reply', bucketSource: 'model' });
  });

  it('pages through a bucket like any list', async () => {
    for (let i = 0; i < 5; i += 1) await conversation([{ intent: model('read_only'), minute: i + 1 }]);
    const first = await list({ folder: 'inbox', bucket: 'read_only', limit: 3 });
    const second = await list({ folder: 'inbox', bucket: 'read_only', limit: 3, cursor: first.body.nextCursor });
    expect(first.body.threads).toHaveLength(3);
    expect(second.body.threads).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
  });

  it('refuses a bucket that does not exist', async () => {
    expect((await list({ folder: 'inbox', bucket: 'urgent' })).status).toBe(400);
  });
});

describe('counting the buckets', () => {
  it('counts the conversations in each bucket of a folder, the user’s own only', async () => {
    await conversation([{ intent: model('needs_reply') }]);
    await conversation([{ intent: model('needs_reply') }]);
    await conversation([{ intent: model('read_only'), folder: 'archive' }]);
    await conversation([{}]);
    await conversation([{ intent: model('needs_reply') }], { userId: new mongoose.Types.ObjectId() });

    const inbox = await request(app).get('/api/threads/buckets').set('Cookie', me.cookie);
    expect(inbox.body).toEqual({ buckets: { needs_reply: 2, waiting_on_them: 0, do_at_a_time: 0, read_only: 0 } });
    const archive = await request(app).get('/api/threads/buckets').query({ folder: 'archive' }).set('Cookie', me.cookie);
    expect(archive.body.buckets.read_only).toBe(1);
  });

  it('needs a signed-in user', async () => {
    expect((await request(app).get('/api/threads/buckets')).status).toBe(401);
  });
});

describe('moving conversations between buckets', () => {
  it('puts the user’s choice on the newest received message, keeping what the model said', async () => {
    const thread = await conversation([{ intent: model('needs_reply') }, { intent: model('read_only') }, { from: 'me' }]);

    const res = await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'do_at_a_time' });
    expect(res.status).toBe(200);
    expect(res.body.threads[0]).toMatchObject({ bucket: 'do_at_a_time', bucketSource: 'user' });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: 'do_at_a_time', modelLabel: 'read_only', source: 'user' });
    // The older message keeps the model's bucket.
    const [first] = await Message.find({ threadId: thread._id }).sort({ sentAt: 1 }).lean();
    expect(first.intent).toMatchObject({ label: 'needs_reply', source: 'model' });
  });

  it('keeps the model’s bucket for mail it sorted before that was stored apart', async () => {
    const thread = await conversation([{ intent: { label: 'read_only', source: 'model' } }]);
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'needs_reply' });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: 'needs_reply', modelLabel: 'read_only' });
  });

  it('keeps what the model said when the user moves a conversation twice', async () => {
    const thread = await conversation([{ intent: model('read_only') }]);
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'needs_reply' });
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'do_at_a_time' });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: 'do_at_a_time', modelLabel: 'read_only', source: 'user' });
  });

  it('moves a selection at once, and leaves a conversation of only sent mail as it is', async () => {
    const a = await conversation([{ intent: model('read_only') }]);
    const b = await conversation([{}]);
    const sentOnly = await conversation([{ from: 'me' }]);

    const res = await batch({ ids: [a, b, sentOnly].map((t) => String(t._id)), action: 'setBucket', bucket: 'needs_reply' });
    expect(res.body.threads.map((t) => t.bucket)).toEqual(['needs_reply', 'needs_reply', null]);
  });

  it('never moves someone else’s conversation', async () => {
    const theirs = await conversation([{ intent: model('read_only') }], { userId: new mongoose.Types.ObjectId() });
    const res = await batch({ ids: [String(theirs._id)], action: 'setBucket', bucket: 'needs_reply' });
    expect(res.body.threads).toEqual([]);
    expect(await reload(theirs)).toMatchObject({ bucket: 'read_only' });
  });

  it('keeps the user’s choice from the model from then on', async () => {
    const thread = await conversation([{}]);
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'do_at_a_time' });
    await triageMessages([(await newestReceived(thread))._id]);
    expect(ai.asked).toEqual([]);
    expect(await reload(thread)).toMatchObject({ bucket: 'do_at_a_time', bucketSource: 'user' });
  });

  it('needs a bucket to move to, and takes one for no other action', async () => {
    const thread = await conversation([{}]);
    expect((await batch({ ids: [String(thread._id)], action: 'setBucket' })).status).toBe(400);
    expect((await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'urgent' })).status).toBe(400);
    expect((await batch({ ids: [String(thread._id)], action: 'archive', bucket: 'read_only' })).status).toBe(400);
  });
});

describe('taking a move back', () => {
  it('returns the conversation to the model’s bucket', async () => {
    const thread = await conversation([{ intent: model('read_only') }]);
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'needs_reply' });

    const res = await batch({ ids: [String(thread._id)], action: 'resetBucket' });
    expect(res.body.threads[0]).toMatchObject({ bucket: 'read_only', bucketSource: 'model' });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: 'read_only', source: 'model' });
  });

  it('leaves no bucket where the model never looked', async () => {
    const thread = await conversation([{}]);
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'needs_reply' });

    const res = await batch({ ids: [String(thread._id)], action: 'resetBucket' });
    expect(res.body.threads[0]).toMatchObject({ bucket: null, bucketSource: null });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: null, source: 'default' });
  });

  it('never records the user’s own choice as the model’s, however often they move it', async () => {
    const thread = await conversation([{}]);
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'needs_reply' });
    await batch({ ids: [String(thread._id)], action: 'setBucket', bucket: 'read_only' });
    expect((await newestReceived(thread)).intent).toMatchObject({ modelLabel: null });

    const res = await batch({ ids: [String(thread._id)], action: 'resetBucket' });
    expect(res.body.threads[0]).toMatchObject({ bucket: null });
  });

  it('leaves alone mail the model sorted before its bucket was stored apart', async () => {
    const thread = await conversation([{ intent: { label: 'read_only', source: 'model' } }]);
    await batch({ ids: [String(thread._id)], action: 'resetBucket' });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: 'read_only', source: 'model' });
  });

  it('changes nothing the user did not choose', async () => {
    const thread = await conversation([{ intent: model('needs_reply') }]);
    await batch({ ids: [String(thread._id)], action: 'resetBucket' });
    expect((await newestReceived(thread)).intent).toMatchObject({ label: 'needs_reply', modelLabel: 'needs_reply', source: 'model' });
  });
});
