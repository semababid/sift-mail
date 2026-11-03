import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connect, disconnect, clearDb } from './helpers.js';
import { IntentLabel, Message, Thread, User } from '../src/models/index.js';
import { EMBEDDING_DIMS } from '../src/lib/constants.js';
import {
  accuracy,
  confusion,
  correctionsFrom,
  evaluate,
  loadCandidates,
  loadEvalItems,
  loadEvalLabels,
  pickEvalSet,
  removeEvalLabel,
  saveEvalLabel,
  SAME_TEXT,
} from '../src/services/triage/evaluation.js';
import { fakeAi } from './fake-ai.js';

const axis = (i) => Array.from({ length: EMBEDDING_DIMS }, (_, j) => (j === i ? 1 : 0));
const towards = (i, similarity) =>
  Array.from({ length: EMBEDDING_DIMS }, (_, j) => (j === 0 ? similarity : j === i ? Math.sqrt(1 - similarity ** 2) : 0));

const oid = () => new mongoose.Types.ObjectId();

// A candidate for the set, unlike every other one unless given a vector.
let next = 0;
const candidate = (fields = {}) => {
  next += 1;
  return {
    _id: oid(),
    threadId: oid(),
    from: { address: `sender${next}@elsewhere.example` },
    real: false,
    seedLabel: 'read_only',
    vector: axis(next),
    ...fields,
  };
};
const ids = (list) => list.map((m) => String(m._id));

describe('picking the messages to label', () => {
  it('takes from each kind of mail in turn, so a small bucket gets what there is', () => {
    const many = Array.from({ length: 10 }, () => candidate({ seedLabel: 'read_only' }));
    const few = [candidate({ seedLabel: 'waiting_on_them' })];
    const real = Array.from({ length: 10 }, () => candidate({ real: true, seedLabel: null }));
    const set = pickEvalSet([...many, ...few, ...real], { size: 5 });
    expect(set).toHaveLength(5);
    expect(set.filter((m) => m.seedLabel === 'waiting_on_them')).toHaveLength(1);
    expect(set.filter((m) => m.real)).toHaveLength(2);
    expect(set.filter((m) => m.seedLabel === 'read_only' && !m.real)).toHaveLength(2);
  });

  it('picks the same messages in the same order whatever order they come in', () => {
    const all = Array.from({ length: 30 }, () => candidate({ seedLabel: ['read_only', 'needs_reply'][next % 2] }));
    const once = ids(pickEvalSet(all, { size: 12 }));
    expect(ids(pickEvalSet([...all].reverse(), { size: 12 }))).toEqual(once);
  });

  it('takes one message from a conversation, and none a copy of one already in', () => {
    const first = candidate();
    const sameThread = candidate({ threadId: first.threadId });
    // Dimensions well clear of the ones candidate() hands out.
    const original = candidate({ vector: axis(0) });
    const copy = candidate({ vector: towards(1000, SAME_TEXT) });
    const alike = candidate({ vector: towards(1001, SAME_TEXT - 0.01) });
    const set = pickEvalSet([first, sameThread, copy, original, alike].map((m) => ({ ...m, seedLabel: 'read_only' })), { size: 10 });
    expect(set).toHaveLength(3);
    expect(ids(set)).toContain(String(alike._id));
    expect(set.filter((m) => [String(copy._id), String(original._id)].includes(String(m._id)))).toHaveLength(1);
    expect(set.filter((m) => [String(first._id), String(sameThread._id)].includes(String(m._id)))).toHaveLength(1);
  });

  it('takes at most a few messages from one real sender, but any number from one seeded one', () => {
    const instagram = { address: 'Notify@Mail.Instagram.example' };
    const real = Array.from({ length: 8 }, (_, i) =>
      candidate({ real: true, seedLabel: null, from: { address: i % 2 ? instagram.address : instagram.address.toLowerCase() } }),
    );
    const seeded = Array.from({ length: 8 }, () => candidate({ from: { address: 'landlord@elsewhere.example' } }));
    const set = pickEvalSet([...real, ...seeded], { size: 20, perSender: 3 });
    expect(set.filter((m) => m.real)).toHaveLength(3);
    expect(set.filter((m) => !m.real)).toHaveLength(8);
  });

  it('keeps what was labelled before, first, and fills up to the size with labelled messages only', () => {
    const all = Array.from({ length: 10 }, () => candidate());
    const done = new Map([
      [String(all[7]._id), false],
      [String(all[8]._id), true],
    ]);
    const set = pickEvalSet(all, { done, size: 3 });
    // Two labelled ones are new, the skipped one does not count towards it.
    expect(set).toHaveLength(4);
    expect(new Set(ids(set.slice(0, 2)))).toEqual(new Set([String(all[7]._id), String(all[8]._id)]));
  });

  it('stops when nothing more fits', () => {
    expect(pickEvalSet([candidate(), candidate()], { size: 10 })).toHaveLength(2);
  });
});

// A labelled message for evaluate, with the bucket the fake model gives it
// zero-shot.
const item = (truth, zeroShot, fields = {}) => {
  next += 1;
  return {
    _id: oid(),
    threadId: oid(),
    truth,
    zeroShot,
    vector: axis(next),
    message: { subject: `Nachricht ${next}`, from: { address: `s${next}@elsewhere.example` }, bulk: false },
    ...fields,
  };
};

// A model that gives each message its zero-shot bucket, and with examples
// copies the first example's bucket. It records every call.
function fakeClassify() {
  const calls = [];
  const classify = async (it, examples) => {
    calls.push({ id: String(it._id), examples: examples.map((e) => e.label) });
    return examples.length > 0 ? examples[0].label : it.zeroShot;
  };
  return { calls, classify };
}

describe('the corrections a user would have made', () => {
  it('are the first mistakes in order, with the bucket given by hand', () => {
    const items = [item('read_only', 'read_only'), item('needs_reply', 'read_only'), item('do_at_a_time', 'do_at_a_time'), item('waiting_on_them', 'needs_reply'), item('read_only', 'needs_reply')];
    const zeroShot = new Map(items.map((i) => [String(i._id), i.zeroShot]));
    const made = correctionsFrom(items, zeroShot, 2);
    expect(made.map((c) => [String(c.messageId), c.label])).toEqual([
      [String(items[1]._id), 'needs_reply'],
      [String(items[3]._id), 'waiting_on_them'],
    ]);
    expect(correctionsFrom(items, zeroShot, 10)).toHaveLength(3);
  });
});

describe('evaluating', () => {
  it('asks the model about every message once with no examples, for zero-shot', async () => {
    const items = [item('read_only', 'read_only'), item('needs_reply', 'read_only')];
    const { calls, classify } = fakeClassify();
    const { zeroShot } = await evaluate(items, { classify, steps: [] });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.examples.length === 0)).toBe(true);
    expect(zeroShot.get(String(items[1]._id))).toBe('read_only');
  });

  it('shows a message the corrections near it, and keeps the zero-shot answer for one with none', async () => {
    // Two mistakes alike, and a message sorted right that is like neither.
    const mistake = item('needs_reply', 'read_only', { vector: axis(0) });
    const like = item('needs_reply', 'read_only', { vector: towards(1002, 0.9) });
    const unlike = item('read_only', 'read_only');
    const { calls, classify } = fakeClassify();
    const { steps } = await evaluate([mistake, like, unlike], { classify, steps: [1] });

    expect(steps[0].predicted.get(String(like._id))).toBe('needs_reply');
    expect(steps[0].predicted.get(String(mistake._id))).toBe('needs_reply');
    expect(steps[0].withExamples).toBe(2);
    // Nothing near it: asked once, zero-shot, and that answer stands.
    expect(calls.filter((c) => c.id === String(unlike._id))).toEqual([{ id: String(unlike._id), examples: [] }]);
    expect(steps[0].predicted.get(String(unlike._id))).toBe('read_only');
    expect(accuracy([mistake, like, unlike], steps[0].predicted).all).toEqual({ right: 3, of: 3 });
  });

  it('leaves each message out of its own corrections', async () => {
    const a = item('needs_reply', 'read_only', { vector: axis(0) });
    const b = item('do_at_a_time', 'read_only', { vector: towards(1003, 0.9) });
    const { calls, classify } = fakeClassify();
    const { steps } = await evaluate([a, b], { classify, steps: [1] });
    // Each is the only mistake the other could learn from.
    expect(steps[0].predicted.get(String(a._id))).toBe('do_at_a_time');
    expect(steps[0].predicted.get(String(b._id))).toBe('needs_reply');
    expect(calls.filter((c) => c.examples.length > 0)).toHaveLength(2);
  });

  it('says how many corrections there were when zero-shot made fewer mistakes than asked for', async () => {
    // Two mistakes. A message sorted right has both to learn from.
    const items = [item('needs_reply', 'read_only'), item('read_only', 'read_only'), item('read_only', 'needs_reply')];
    const { classify } = fakeClassify();
    const { steps } = await evaluate(items, { classify, steps: [1, 10] });
    expect(steps.map((s) => [s.n, s.corrections])).toEqual([
      [1, 1],
      [10, 2],
    ]);
  });

  it('asks about a message and the same examples once across all the steps', async () => {
    const mistake = item('needs_reply', 'read_only', { vector: axis(0) });
    const like = item('needs_reply', 'read_only', { vector: towards(1004, 0.9) });
    const { calls, classify } = fakeClassify();
    await evaluate([mistake, like, item('read_only', 'read_only')], { classify, steps: [5, 10, 25] });
    const withExamples = calls.filter((c) => c.examples.length > 0);
    expect(new Set(withExamples.map((c) => c.id)).size).toBe(withExamples.length);
  });

  it('scores each bucket by the messages labelled with it, and counts what went where', () => {
    const items = [item('needs_reply', null), item('needs_reply', null), item('read_only', null), item('do_at_a_time', null)];
    const predicted = new Map([
      [String(items[0]._id), 'needs_reply'],
      [String(items[1]._id), 'read_only'],
      [String(items[2]._id), 'read_only'],
    ]);
    const table = accuracy(items, predicted);
    expect(table.needs_reply).toEqual({ right: 1, of: 2 });
    expect(table.read_only).toEqual({ right: 1, of: 1 });
    expect(table.do_at_a_time).toEqual({ right: 0, of: 1 });
    expect(table.waiting_on_them).toEqual({ right: 0, of: 0 });
    expect(table.all).toEqual({ right: 2, of: 4 });
    const matrix = confusion(items, predicted);
    expect(matrix.needs_reply).toMatchObject({ needs_reply: 1, read_only: 1 });
    expect(matrix.do_at_a_time.none).toBe(1);
  });
});

describe('labels given by hand', () => {
  beforeAll(connect);
  afterAll(disconnect);
  beforeEach(clearDb);

  const userId = oid();
  async function stored(fields = {}) {
    const thread = await Thread.create({ userId, lastMessageAt: new Date() });
    const [message] = await Message.insertMany([
      {
        userId,
        threadId: thread._id,
        from: { address: 'mara@elsewhere.example' },
        subject: `Betreff ${(next += 1)}`,
        bodyText: `Text ${next}`,
        folder: 'inbox',
        sentAt: new Date(),
        ...fields,
      },
    ]);
    return message;
  }

  it('are stored apart from the seeder’s and the user’s, and replaced when given again', async () => {
    const message = await stored();
    await IntentLabel.create({ userId, messageId: message._id, label: 'read_only', source: 'seed' });
    await IntentLabel.create({ userId, messageId: message._id, label: 'needs_reply', source: 'user' });
    await saveEvalLabel(userId, message._id, 'do_at_a_time');
    await saveEvalLabel(userId, message._id, 'waiting_on_them');
    expect(await IntentLabel.countDocuments({ messageId: message._id })).toBe(3);
    expect(await loadEvalLabels(userId)).toEqual(new Map([[String(message._id), { label: 'waiting_on_them', skipped: false }]]));
  });

  it('keep a skip, without a bucket, and can be taken back', async () => {
    const message = await stored();
    await saveEvalLabel(userId, message._id, null);
    expect(await loadEvalLabels(userId)).toEqual(new Map([[String(message._id), { label: null, skipped: true }]]));
    await removeEvalLabel(message._id);
    expect(await loadEvalLabels(userId)).toEqual(new Map());
  });

  it('need a bucket unless they are an eval skip', async () => {
    await expect(IntentLabel.create({ userId, messageId: oid(), source: 'eval' })).rejects.toThrow(/needs a bucket/);
    await expect(IntentLabel.create({ userId, messageId: oid(), source: 'user', skipped: true })).rejects.toThrow(/needs a bucket/);
  });

  it('give the evaluation the labelled messages only, with their vectors', async () => {
    const ai = fakeAi();
    const labelled = await stored({ imap: { account: 'a', mailbox: 'INBOX', uidValidity: '1', uid: 1 } });
    const skipped = await stored();
    const unlabelled = await stored();
    await saveEvalLabel(userId, labelled._id, 'needs_reply');
    await saveEvalLabel(userId, skipped._id, null);

    const items = await loadEvalItems(userId, { ai });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ truth: 'needs_reply', real: true, message: { subject: labelled.subject } });
    expect(items[0].vector).toHaveLength(EMBEDDING_DIMS);
    expect(ids(items)).not.toContain(String(unlabelled._id));
  });

  it('are picked from received mail only, with the seeder’s bucket and a vector for each', async () => {
    const ai = fakeAi();
    await User.create({ _id: userId, email: 'semab@sift.example', passwordHash: 'x', name: 'Semab' });
    const inbox = await stored();
    // Mail to self, from the Sift address and from the imported account.
    await stored({ from: { address: 'Semab@Sift.example' } });
    await stored({
      from: { address: 'semab@mail.example' },
      imap: { account: 'semab@mail.example', mailbox: 'INBOX', uidValidity: '1', uid: 2 },
    });
    await stored({ folder: 'sent' });
    await stored({ folder: 'drafts', isDraft: true });
    await stored({ bodyStatus: 'pending' });
    await stored({ userId: oid() });
    await IntentLabel.create({ userId, messageId: inbox._id, label: 'do_at_a_time', source: 'seed' });
    // Seeded before stage 4.5, with no bodyStatus at all.
    const old = await stored();
    await Message.collection.updateOne({ _id: old._id }, { $unset: { bodyStatus: '' } });

    const candidates = await loadCandidates(userId, { ai });
    expect(ids(candidates).sort()).toEqual([String(inbox._id), String(old._id)].sort());
    expect(candidates.find((c) => String(c._id) === String(inbox._id))).toMatchObject({ real: false, seedLabel: 'do_at_a_time' });
    expect(candidates.every((c) => c.vector.length === EMBEDDING_DIMS)).toBe(true);
  });
});
