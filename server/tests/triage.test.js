import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { Message, Thread, User } from '../src/models/index.js';
import { setAi } from '../src/services/ai/index.js';
import { triageMessages } from '../src/services/triage/triage-messages.js';
import { createTriageQueue, flushTriage } from '../src/services/triage/queue.js';
import { countNeedingTriage, runTriageBackfill } from '../src/services/triage/backfill.js';
import { flushEmbeddings } from '../src/services/embedding/queue.js';
import { fetchPendingBodies, importNewMail } from '../src/services/imap/importer.js';
import { ACCOUNT, fakeMailbox, mail } from './imap-fixtures.js';
import { fakeAi } from './fake-ai.js';

const app = createApp();

beforeAll(connect);
afterAll(async () => {
  setAi(undefined);
  await disconnect();
});

const people = {
  anna: { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' },
  ben: { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' },
};

let ai;
beforeEach(async () => {
  await flushTriage();
  await flushEmbeddings();
  await clearDb();
  ai = fakeAi();
  setAi(ai);
});

const send = (who, body) => request(app).post('/api/messages').set('Cookie', who.cookie).send(body);
const intentOf = async (filter) => (await Message.findOne(filter).lean()).intent;

// Mail stored straight in the database for one user, received unless
// `fields` says otherwise, `count` messages a minute apart.
let ownerId;
async function received(count, fields = {}) {
  ownerId ??= (await User.create({ email: 'cleo@sift.example', passwordHash: 'x', name: 'Cleo' }))._id;
  const userId = fields.userId ?? ownerId;
  const thread = await Thread.create({ userId, lastMessageAt: new Date() });
  const docs = await Message.insertMany(
    Array.from({ length: count }, (_, i) => ({
      userId,
      threadId: thread._id,
      from: { name: 'Mara', address: 'mara@elsewhere.example' },
      to: [{ address: 'cleo@sift.example' }],
      subject: `Nachricht ${i}`,
      bodyText: `Inhalt ${i}`,
      folder: 'inbox',
      sentAt: new Date(Date.UTC(2026, 4, 1) + i * 60_000),
      ...fields,
    })),
  );
  return docs.map((doc) => doc._id);
}
beforeEach(() => {
  ownerId = undefined;
});

describe('sorting mail as it arrives', () => {
  it('gives each recipient’s copy a bucket, and leaves the sender’s copy alone', async () => {
    const anna = await signIn(app, people.anna);
    const ben = await signIn(app, people.ben);
    ai.state.bucket = () => 'needs_reply';
    await send(anna, { to: [people.ben.email], subject: 'Kino?', bodyText: 'Hast du morgen Zeit?' });
    await flushTriage();

    expect(await intentOf({ userId: ben.user._id })).toMatchObject({
      label: 'needs_reply',
      reason: 'Fake reason.',
      model: 'fake/chat',
      source: 'model',
      classifiedAt: expect.any(Date),
    });
    expect(await intentOf({ userId: anna.user._id })).toMatchObject({ label: null, source: 'default', classifiedAt: null });
    // Sorted for Ben, by Ben's name.
    expect(ai.asked).toHaveLength(1);
    expect(ai.asked[0].system).toContain('Ben <ben@sift.example>');
  });

  it('answers the send before the bucket exists, however slow the model is', async () => {
    const anna = await signIn(app, people.anna);
    const ben = await signIn(app, people.ben);
    ai.state.delayMs = 2_000;

    const started = performance.now();
    const res = await send(anna, { to: [people.ben.email], subject: 'Kino?', bodyText: 'Zeit?' });
    expect(res.status).toBe(201);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await intentOf({ userId: ben.user._id })).toMatchObject({ classifiedAt: null });
    ai.state.delayMs = 0;
  });

  it('still sends when the model is down, and leaves the copy for the backfill', async () => {
    const anna = await signIn(app, people.anna);
    const ben = await signIn(app, people.ben);
    ai.state.fail = 'unavailable';

    expect((await send(anna, { to: [people.ben.email], subject: 'Kino?', bodyText: 'Zeit?' })).status).toBe(201);
    await flushTriage();
    expect(await intentOf({ userId: ben.user._id })).toMatchObject({ classifiedAt: null });
    expect((await countNeedingTriage()).total).toBe(1);
  });

  it('sorts imported mail once its text has arrived, and not before', async () => {
    const anna = await signIn(app, people.anna);
    const mailbox = fakeMailbox([mail(1, { subject: 'Termin', text: 'Ihr Termin ist am Montag.' })]);
    await importNewMail({ user: anna.user, client: mailbox.client, account: ACCOUNT });
    await flushTriage();
    expect(ai.asked).toEqual([]);

    await fetchPendingBodies({ user: anna.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
    await flushTriage();
    expect(ai.asked).toHaveLength(1);
    expect(ai.asked[0].messages[0].content).toContain('Ihr Termin ist am Montag.');
    expect(await intentOf({ userId: anna.user._id })).toMatchObject({ source: 'model', label: 'read_only' });
  });
});

describe('triageMessages', () => {
  it('sorts received mail, in the inbox or the archive', async () => {
    const ids = [...(await received(1)), ...(await received(1, { folder: 'archive' }))];
    expect(await triageMessages(ids)).toEqual({ classified: 2, failedIds: [] });
  });

  it('leaves out what is not received mail, or has no text yet', async () => {
    const ids = [
      ...(await received(1, { folder: 'sent' })),
      ...(await received(1, { folder: 'drafts', isDraft: true })),
      ...(await received(1, { folder: 'spam' })),
      ...(await received(1, { folder: 'trash', trashedFrom: 'inbox' })),
      ...(await received(1, { bodyStatus: 'pending' })),
    ];
    expect(await triageMessages(ids)).toEqual({ classified: 0, failedIds: [] });
    expect(ai.asked).toEqual([]);
  });

  it('never asks again about a message it has sorted', async () => {
    const ids = await received(2);
    await triageMessages(ids);
    await triageMessages(ids);
    expect(ai.asked).toHaveLength(2);
  });

  it('never touches a bucket the user chose', async () => {
    const [id] = await received(1, { intent: { label: 'do_at_a_time', source: 'user' } });
    expect(await triageMessages([id])).toEqual({ classified: 0, failedIds: [] });
    expect(ai.asked).toEqual([]);
  });

  it('keeps the user’s choice when it lands while the model is still thinking', async () => {
    const [id] = await received(1);
    const original = ai.generate;
    ai.generate = async (req) => {
      // The user drags the message into a bucket before the answer is back.
      await Message.updateOne({ _id: id }, { $set: { intent: { label: 'do_at_a_time', source: 'user' } } });
      return original(req);
    };

    expect(await triageMessages([id])).toEqual({ classified: 0, failedIds: [] });
    expect(await intentOf({ _id: id })).toMatchObject({ label: 'do_at_a_time', source: 'user' });
  });

  it('skips a message the model answers with nonsense twice, and carries on with the rest', async () => {
    const ids = await received(3);
    ai.state.answer = (req) => (req.messages[0].content.includes('Inhalt 1') ? 'Kino!' : null);

    const result = await triageMessages(ids);
    expect(result).toEqual({ classified: 2, failedIds: [String(ids[1])] });
    expect(await intentOf({ _id: ids[1] })).toMatchObject({ classifiedAt: null });
  });

  it('stops at a model that is down, saying what it had done', async () => {
    const ids = await received(3);
    const original = ai.generate;
    ai.generate = async (req) => {
      // The first answer comes back, then the model goes down.
      if (ai.asked.length === 1) ai.state.fail = 'unavailable';
      return original(req);
    };

    const err = await triageMessages(ids).catch((error) => error);
    expect(err).toMatchObject({ code: 'unavailable', partial: { classified: 1, failedIds: [] } });
    expect(ai.asked).toHaveLength(2);
  });

  it('stops between messages once cancelled, keeping what it did', async () => {
    const ids = await received(3);
    const controller = new AbortController();
    const original = ai.generate;
    ai.generate = async (req) => {
      const answer = await original(req);
      controller.abort();
      return answer;
    };

    expect(await triageMessages(ids, { signal: controller.signal })).toEqual({ classified: 1, failedIds: [] });
    expect(ai.asked).toHaveLength(1);
  });

  it('cancels the message in hand when told to', async () => {
    const ids = await received(3);
    ai.state.delayMs = 5_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(triageMessages(ids, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(ai.asked).toHaveLength(1);
  });
});

describe('the triage queue', () => {
  it('drops what is waiting and cancels the model when stopped', async () => {
    // More than one batch, so some are still waiting when it stops.
    const ids = await received(12);
    ai.state.delayMs = 5_000;
    const queue = createTriageQueue({ gatherMs: 1 });
    queue.add(ids);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const started = performance.now();
    await queue.stop();
    expect(performance.now() - started).toBeLessThan(500);
    expect(queue.size).toBe(0);
    expect(ai.asked).toHaveLength(1);
    // Nothing more is taken once it has stopped.
    queue.add(ids);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ai.asked).toHaveLength(1);
    expect(queue.size).toBe(0);
    expect((await countNeedingTriage()).total).toBe(12);
  });
});

describe('the triage backfill', () => {
  const backfill = (options = {}) => runTriageBackfill({ chunkSize: 4, wait: async () => {}, ...options });

  it('sorts everything without a bucket, newest first, and leaves nothing behind', async () => {
    await received(10);
    const result = await backfill();
    expect(result).toMatchObject({ classified: 10, failed: 0, total: 10, stopped: null });
    expect(ai.asked[0].messages[0].content).toContain('Inhalt 9');
    expect((await countNeedingTriage()).total).toBe(0);
  });

  it('stops after the number it was given, and carries on from there next time', async () => {
    await received(10);
    expect(await backfill({ limit: 6 })).toMatchObject({ classified: 6, stopped: 'limit' });
    expect(await backfill()).toMatchObject({ classified: 4, stopped: null });
  });

  it('only does the accounts it was given', async () => {
    const other = (await User.create({ email: 'dana@sift.example', passwordHash: 'x', name: 'Dana' }))._id;
    await received(3);
    await received(2, { userId: other });
    expect(await backfill({ userIds: [other] })).toMatchObject({ classified: 2 });
    expect((await countNeedingTriage()).total).toBe(3);
  });

  it('waits for a model that is briefly down, and counts the work done before it went', async () => {
    await received(4);
    let calls = 0;
    const original = ai.generate;
    ai.generate = async (req) => {
      calls += 1;
      if (calls === 3) throw Object.assign(new Error('down'), { code: 'unavailable', retryable: true });
      return original(req);
    };
    const waits = [];

    const result = await backfill({ wait: async (ms) => waits.push(ms) });
    expect(result).toMatchObject({ classified: 4, failed: 0 });
    expect(waits).toEqual([2_000]);
  });

  it('counts a message the model cannot sort once, even when its chunk is tried again', async () => {
    await received(4);
    let calls = 0;
    ai.state.answer = (req) => (req.messages[0].content.includes('Inhalt 2') ? 'Kino!' : null);
    const original = ai.generate;
    ai.generate = async (req) => {
      calls += 1;
      // After the bad answers for "Inhalt 2", the model goes down once.
      if (calls === 4) throw Object.assign(new Error('down'), { code: 'unavailable', retryable: true });
      return original(req);
    };

    expect(await backfill()).toMatchObject({ classified: 3, failed: 1 });
    // Asked twice, once and then for a correction, and not again on the retry.
    expect(ai.asked.filter((req) => req.messages[0].content.includes('Inhalt 2'))).toHaveLength(2);
  });

  it('stops at once when the model is not there, keeping what it did', async () => {
    await received(6);
    let calls = 0;
    const original = ai.generate;
    ai.generate = async (req) => {
      calls += 1;
      if (calls === 3) ai.state.fail = 'model_missing';
      return original(req);
    };
    const waits = [];

    const err = await backfill({ wait: async (ms) => waits.push(ms) }).catch((error) => error);
    expect(err).toMatchObject({ code: 'model_missing', totals: { classified: 2 } });
    expect(waits).toEqual([]);
    expect((await countNeedingTriage()).total).toBe(4);
  });

  it('stops between chunks when asked, and at once when cancelled', async () => {
    await received(10);
    let chunks = 0;
    expect(await backfill({ shouldStop: () => chunks >= 1, onProgress: () => (chunks += 1) })).toMatchObject({
      classified: 4,
      stopped: 'asked',
    });

    ai.state.delayMs = 5_000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await backfill({ signal: controller.signal })).toMatchObject({ classified: 0, stopped: 'asked' });
  });
});

describe('who it is sorted for', () => {
  it('uses the account the mail belongs to, by name', async () => {
    const [id] = await received(1);
    await triageMessages([id]);
    expect(ai.asked[0].system).toContain('Cleo <cleo@sift.example>');
    expect(String((await Message.findById(id)).userId)).toBe(String(ownerId));
    expect(mongoose.isValidObjectId(ownerId)).toBe(true);
  });
});
