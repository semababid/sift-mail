import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { EMBEDDING_DIMS } from '../src/lib/constants.js';
import { embeddingText } from '../src/lib/embedding-text.js';
import { EmbeddingCache, Message, Thread } from '../src/models/index.js';
import { setAi } from '../src/services/ai/index.js';
import { fakeAi } from './fake-ai.js';
import { EMBED_BATCH, embedMessages } from '../src/services/embedding/embed-messages.js';
import { createEmbedQueue, flushEmbeddings } from '../src/services/embedding/queue.js';
import { fetchPendingBodies, importNewMail } from '../src/services/imap/importer.js';
import { ACCOUNT, fakeMailbox, mail } from './imap-fixtures.js';

const app = createApp();

beforeAll(connect);
afterAll(async () => {
  setAi(undefined);
  await disconnect();
});

const people = {
  anna: { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' },
  ben: { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' },
  cleo: { email: 'cleo@sift.example', password: 'correct-horse', name: 'Cleo' },
};

let ai;
let anna;
beforeEach(async () => {
  await flushEmbeddings();
  await clearDb();
  ai = fakeAi();
  setAi(ai);
  anna = await signIn(app, people.anna);
});

const send = (who, body) => request(app).post('/api/messages').set('Cookie', who.cookie).send(body);
const withVectors = (filter = {}) => Message.find(filter).select('+embedding').lean();
const texts = () => ai.calls.flatMap((call) => call.texts);

describe('embedding mail as it is written', () => {
  it('gives the sender’s copy and every recipient’s copy a vector, asking the model once', async () => {
    await signIn(app, people.ben);
    await signIn(app, people.cleo);
    await send(anna, { to: [people.ben.email, people.cleo.email], subject: 'Wohnung', bodyText: 'Ist sie noch frei?' });
    await flushEmbeddings();

    const messages = await withVectors();
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.embedding).toHaveLength(EMBEDDING_DIMS);
      expect(message.embeddingModel).toBe('fake/embedder');
      expect(message.embeddedAt).toBeInstanceOf(Date);
    }
    expect(ai.calls).toEqual([{ texts: [embeddingText({ subject: 'Wohnung', bodyText: 'Ist sie noch frei?' })], purpose: 'document' }]);
  });

  it('answers the send before the vector exists', async () => {
    ai.state.delayMs = 400;
    const started = Date.now();
    const res = await send(anna, { to: ['mara@elsewhere.example'], subject: 'Schnell', bodyText: 'Antwort sofort' });

    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(400);
    expect((await Message.findById(res.body.message.id).lean()).embeddedAt).toBeNull();

    await flushEmbeddings();
    expect((await Message.findById(res.body.message.id).lean()).embeddedAt).toBeInstanceOf(Date);
  });

  it('gathers a burst of writes into one call to the model', async () => {
    await Promise.all(
      ['eins', 'zwei', 'drei'].map((word) => send(anna, { to: ['mara@elsewhere.example'], subject: word, bodyText: word })),
    );
    await flushEmbeddings();

    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].texts).toHaveLength(3);
  });

  it('never asks the model again for text it has embedded before', async () => {
    await send(anna, { to: ['mara@elsewhere.example'], subject: 'Erinnerung', bodyText: 'Miete fällig' });
    await flushEmbeddings();
    await send(anna, { to: ['jonas@elsewhere.example'], subject: 'Erinnerung', bodyText: 'Miete fällig' });
    await flushEmbeddings();

    expect(texts()).toHaveLength(1);
    const [first, second] = await withVectors({ folder: 'sent' });
    expect(second.embedding).toEqual(first.embedding);
  });

  it('keeps sending when the model is down, and leaves the vector for the backfill', async () => {
    ai.state.fail = 'unavailable';
    const res = await send(anna, { to: ['mara@elsewhere.example'], subject: 'Trotzdem', bodyText: 'geht raus' });
    expect(res.status).toBe(201);
    await flushEmbeddings();
    expect((await Message.findById(res.body.message.id).lean()).embeddedAt).toBeNull();

    // Back up: the same message embeds when asked again.
    ai.state.fail = null;
    expect(await embedMessages([res.body.message.id])).toEqual({ embedded: 1, asked: 1 });
    expect(await EmbeddingCache.countDocuments()).toBe(1);
  });

  it('leaves drafts alone while they are written, and embeds them once sent', async () => {
    const draft = (await request(app).post('/api/drafts').set('Cookie', anna.cookie).send({ to: ['mara@elsewhere.example'], subject: 'Entwurf', bodyText: 'eins' })).body.draft;
    await request(app).patch(`/api/drafts/${draft.id}`).set('Cookie', anna.cookie).send({ bodyText: 'eins zwei' });
    await flushEmbeddings();
    expect(await embedMessages([draft.id])).toEqual({ embedded: 0, asked: 0 });
    expect(ai.calls).toEqual([]);

    await request(app).post(`/api/drafts/${draft.id}/send`).set('Cookie', anna.cookie);
    await flushEmbeddings();
    const sent = await Message.findById(draft.id).select('+embedding').lean();
    expect(sent.embedding).toHaveLength(EMBEDDING_DIMS);
    expect(texts()).toEqual([embeddingText({ subject: 'Entwurf', bodyText: 'eins zwei' })]);
  });

  it('marks a message with no text as done, without a vector or a call', async () => {
    const res = await send(anna, { to: ['mara@elsewhere.example'], bodyText: '   ' });
    await flushEmbeddings();

    const message = await Message.findById(res.body.message.id).select('+embedding').lean();
    expect(message.embeddedAt).toBeInstanceOf(Date);
    expect(message.embedding).toBeUndefined();
    expect(ai.calls).toEqual([]);
  });
});

describe('embedMessages', () => {
  async function stored(count, { userId = anna.user._id } = {}) {
    const thread = await Thread.create({ userId, lastMessageAt: new Date() });
    const docs = await Message.insertMany(
      Array.from({ length: count }, (_, i) => ({
        userId,
        threadId: thread._id,
        from: { address: 'mara@elsewhere.example' },
        subject: `Nachricht ${i}`,
        bodyText: `Inhalt ${i}`,
        folder: 'inbox',
        sentAt: new Date(),
      })),
    );
    return docs.map((doc) => doc._id);
  }

  it(`sends the model at most ${EMBED_BATCH} texts at a time`, async () => {
    const ids = await stored(70);
    expect(await embedMessages(ids)).toEqual({ embedded: 70, asked: 70 });
    expect(ai.calls.map((call) => call.texts.length)).toEqual([32, 32, 6]);
  });

  it('does nothing for messages that already have a vector from this model', async () => {
    const ids = await stored(3);
    await embedMessages(ids);
    expect(await embedMessages(ids)).toEqual({ embedded: 0, asked: 0 });
    expect(ai.calls).toHaveLength(1);
  });

  it('embeds again for a new model, and keeps the two models’ vectors apart', async () => {
    const ids = await stored(2);
    await embedMessages(ids);

    const other = fakeAi('fake/other');
    expect(await embedMessages(ids, { ai: other })).toEqual({ embedded: 2, asked: 2 });
    const messages = await withVectors({ _id: { $in: ids } });
    expect(messages.every((m) => m.embeddingModel === 'fake/other')).toBe(true);
    expect((await EmbeddingCache.find().lean()).map((entry) => entry.model).sort()).toEqual([
      'fake/embedder',
      'fake/embedder',
      'fake/other',
      'fake/other',
    ]);
  });

  it('writes nothing when the model fails, so the whole batch is found again later', async () => {
    const ids = await stored(3);
    ai.state.fail = 'unavailable';
    await expect(embedMessages(ids)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await Message.countDocuments({ embeddedAt: { $ne: null } })).toBe(0);
    expect(await EmbeddingCache.countDocuments()).toBe(0);
  });

  it('keeps cache entries for a limited time', async () => {
    const indexes = await EmbeddingCache.collection.indexes();
    expect(indexes.find((index) => index.key.createdAt === 1)).toMatchObject({ expireAfterSeconds: 90 * 24 * 60 * 60 });
  });
});

describe('imported mail', () => {
  const run = async (mailbox) => {
    await importNewMail({ user: anna.user, client: mailbox.client, account: ACCOUNT });
    await flushEmbeddings();
  };

  it('waits for the text to arrive before embedding', async () => {
    const mailbox = fakeMailbox([mail(1, { subject: 'Kaution', text: 'Die Kaution kommt zurück.' })]);
    await run(mailbox);
    expect(ai.calls).toEqual([]);
    // Not even when asked for directly, as the backfill does.
    const [pending] = await Message.find({ userId: anna.user._id }).lean();
    expect(await embedMessages([pending._id])).toEqual({ embedded: 0, asked: 0 });

    await fetchPendingBodies({ user: anna.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
    await flushEmbeddings();
    expect(texts()).toEqual(['Kaution\n\nDie Kaution kommt zurück.']);
  });

  it('embeds from the subject alone when the text could not be fetched', async () => {
    const mailbox = fakeMailbox([mail(1, { subject: 'Nur der Betreff' })]);
    await run(mailbox);
    mailbox.box.delete(1);

    await fetchPendingBodies({ user: anna.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
    await flushEmbeddings();
    expect(texts()).toEqual(['Nur der Betreff']);
  });
});

describe('the queue', () => {
  it('carries on after a batch fails', async () => {
    const seen = [];
    const embed = vi.fn(async (ids) => {
      seen.push(ids);
      if (seen.length === 1) throw new Error('down');
    });
    const queue = createEmbedQueue({ embed, gatherMs: 5 });

    queue.add(Array.from({ length: 150 }, (_, i) => `id-${i}`));
    await queue.flush();
    expect(seen.map((ids) => ids.length)).toEqual([100, 50]);
    expect(queue.size).toBe(0);
  });

  it('embeds what is added while a batch is running', async () => {
    const seen = [];
    let queue;
    const embed = async (ids) => {
      seen.push(ids);
      if (seen.length === 1) queue.add(['later']);
    };
    queue = createEmbedQueue({ embed, gatherMs: 5 });

    queue.add(['first']);
    await queue.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual([['first'], ['later']]);
  });

  it('never strands a message added just as a batch finishes', async () => {
    // How many steps after the model answers the message arrives. Somewhere in
    // this range it lands after the queue has taken its last batch and before
    // it has gone idle, where a queue that only checks for more work inside its
    // loop would leave it waiting until something else was added.
    for (let steps = 0; steps < 12; steps += 1) {
      const seen = [];
      let queue;
      const embed = async (ids) => {
        seen.push(...ids);
        if (ids.includes('first')) {
          let later = Promise.resolve();
          for (let i = 0; i < steps; i += 1) later = later.then(() => {});
          later.then(() => queue.add(['late']));
        }
      };
      queue = createEmbedQueue({ embed, gatherMs: 5 });
      queue.add(['first']);
      await queue.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({ steps, seen }).toEqual({ steps, seen: ['first', 'late'] });
    }
  });

  it('takes each message once however often it is added', async () => {
    const seen = [];
    const queue = createEmbedQueue({ embed: async (ids) => seen.push(ids), gatherMs: 5 });
    queue.add(['a', 'b']);
    queue.add(['b', 'a', 'c']);
    await queue.flush();
    expect(seen).toEqual([['a', 'b', 'c']]);
  });
});
