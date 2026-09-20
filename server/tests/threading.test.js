import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connect, disconnect, clearDb } from './helpers.js';
import { Message, Thread } from '../src/models/index.js';
import { findThreadFor, SUBJECT_WINDOW_MS } from '../src/services/threading.js';
import { parseMessageIds, referenceChain } from '../src/lib/headers.js';

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();

const MARA = 'mara@elsewhere.example';
const JONAS = 'jonas@elsewhere.example';
const ME = 'semab@sift.example';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-05-01T09:00:00.000Z');

// One stored conversation: a thread with a message in it, the way a mailbox
// holds it.
async function stored({
  owner = userId,
  subject = 'Wohnung',
  participants = [MARA, ME],
  rfcMessageId = null,
  references = [],
  sentAt = NOW,
  folders = ['inbox'],
} = {}) {
  const thread = await Thread.create({
    userId: owner,
    subject,
    normalizedSubject: subject.replace(/^((re|aw|fwd)\s*:\s*)+/i, '').trim().toLowerCase(),
    participants: participants.map((address) => ({ address })),
    lastMessageAt: sentAt,
    folders,
  });
  await Message.create({
    userId: owner,
    threadId: thread._id,
    from: { address: participants[0] },
    to: participants.slice(1).map((address) => ({ address })),
    subject,
    rfcMessageId,
    references,
    folder: folders[0],
    sentAt,
  });
  return thread;
}

// An arriving message, as the threading service takes it.
const arriving = (overrides = {}) => ({
  rfcMessageId: '<new@elsewhere.example>',
  inReplyTo: null,
  references: [],
  subject: 'Re: Wohnung',
  participants: [MARA, ME],
  sentAt: NOW,
  ...overrides,
});

describe('threading by headers', () => {
  it('joins the thread of the message In-Reply-To names', async () => {
    const thread = await stored({ rfcMessageId: '<first@elsewhere.example>' });

    const found = await findThreadFor(userId, arriving({ inReplyTo: '<first@elsewhere.example>' }));
    expect(String(found)).toBe(String(thread._id));
  });

  it('works back along References when the message named directly is not here', async () => {
    const thread = await stored({ rfcMessageId: '<first@elsewhere.example>' });

    const found = await findThreadFor(
      userId,
      arriving({
        inReplyTo: '<never-arrived@elsewhere.example>',
        references: ['<first@elsewhere.example>', '<never-arrived@elsewhere.example>'],
      }),
    );
    expect(String(found)).toBe(String(thread._id));
  });

  it('prefers the direct parent when the chain names several conversations', async () => {
    const older = await stored({ subject: 'Wohnung', rfcMessageId: '<older@elsewhere.example>' });
    const parent = await stored({ subject: 'Kaution', rfcMessageId: '<parent@elsewhere.example>' });

    const found = await findThreadFor(
      userId,
      arriving({
        inReplyTo: '<parent@elsewhere.example>',
        references: ['<older@elsewhere.example>'],
      }),
    );
    expect(String(found)).toBe(String(parent._id));
    expect(String(found)).not.toBe(String(older._id));
  });

  it('takes the newest of the referenced conversations when no parent is named', async () => {
    await stored({ rfcMessageId: '<oldest@elsewhere.example>' });
    const recent = await stored({ subject: 'Wohnung', rfcMessageId: '<recent@elsewhere.example>' });

    const found = await findThreadFor(
      userId,
      // References run oldest first, so the last one is the nearest ancestor.
      arriving({ references: ['<oldest@elsewhere.example>', '<recent@elsewhere.example>'] }),
    );
    expect(String(found)).toBe(String(recent._id));
  });

  it('never reaches into another mailbox', async () => {
    await stored({ owner: otherUserId, rfcMessageId: '<first@elsewhere.example>' });

    const found = await findThreadFor(userId, arriving({ inReplyTo: '<first@elsewhere.example>' }));
    expect(found).toBeNull();
  });

  it('starts a new conversation when the ids name nothing here', async () => {
    await stored({ rfcMessageId: '<first@elsewhere.example>' });

    const found = await findThreadFor(userId, arriving({ inReplyTo: '<somewhere-else@elsewhere.example>' }));
    expect(found).toBeNull();
  });

  it('finds the conversation of a reply that arrived before the message it answers', async () => {
    const thread = await stored({
      subject: 'Re: Wohnung',
      rfcMessageId: '<reply@elsewhere.example>',
      references: ['<late@elsewhere.example>'],
    });

    // The message the stored reply names turns up afterwards.
    const found = await findThreadFor(userId, arriving({ rfcMessageId: '<late@elsewhere.example>' }));
    expect(String(found)).toBe(String(thread._id));
  });
});

describe('threading by subject, for mail with no headers', () => {
  const headerless = (overrides) => arriving({ rfcMessageId: null, inReplyTo: null, references: [], ...overrides });
  const withFallback = (message) => findThreadFor(userId, message, { subjectFallback: true, selfAddress: ME });

  it('joins a conversation with the same subject and somebody in common', async () => {
    const thread = await stored({ subject: 'Wohnung', participants: [MARA, ME] });

    const found = await withFallback(headerless({ subject: 'AW: Wohnung', participants: [MARA, ME] }));
    expect(String(found)).toBe(String(thread._id));
  });

  it('leaves it alone unless the fallback is asked for', async () => {
    await stored({ subject: 'Wohnung' });

    expect(await findThreadFor(userId, headerless())).toBeNull();
  });

  it('ignores a conversation with nobody in common but the owner of the mailbox', async () => {
    await stored({ subject: 'Wohnung', participants: [JONAS, ME] });

    expect(await withFallback(headerless({ participants: [MARA, ME] }))).toBeNull();
  });

  it('leaves mail addressed to nobody but yourself on its own', async () => {
    await stored({ subject: 'Wohnung', participants: [ME] });

    expect(await withFallback(headerless({ participants: [ME] }))).toBeNull();
  });

  it('ignores mail with no subject at all', async () => {
    await stored({ subject: '' });

    expect(await withFallback(headerless({ subject: '   ' }))).toBeNull();
  });

  it('ignores a conversation last touched outside the window', async () => {
    const longAgo = new Date(NOW.getTime() - SUBJECT_WINDOW_MS - DAY);
    await stored({ subject: 'Wohnung', sentAt: longAgo });

    expect(await withFallback(headerless())).toBeNull();
  });

  it('still joins one that went quiet for a few days', async () => {
    const thread = await stored({ subject: 'Wohnung', sentAt: new Date(NOW.getTime() - 3 * DAY) });

    expect(String(await withFallback(headerless()))).toBe(String(thread._id));
  });

  it('ignores a conversation that is only in trash or spam', async () => {
    await stored({ subject: 'Wohnung', folders: ['trash'] });

    expect(await withFallback(headerless())).toBeNull();
  });

  it('takes the most recent when several match', async () => {
    await stored({ subject: 'Wohnung', sentAt: new Date(NOW.getTime() - 2 * DAY) });
    const recent = await stored({ subject: 'Wohnung', sentAt: new Date(NOW.getTime() - DAY) });

    expect(String(await withFallback(headerless()))).toBe(String(recent._id));
  });

  it('lets the headers win when a message has both', async () => {
    await stored({ subject: 'Wohnung', participants: [MARA, ME] });
    const named = await stored({ subject: 'Kaution', rfcMessageId: '<parent@elsewhere.example>' });

    const found = await withFallback(arriving({ subject: 'Wohnung', inReplyTo: '<parent@elsewhere.example>' }));
    expect(String(found)).toBe(String(named._id));
  });
});

describe('message id headers', () => {
  it('reads ids however a client wrote them', () => {
    expect(parseMessageIds('<a@x.example> <b@x.example>')).toEqual(['<a@x.example>', '<b@x.example>']);
    expect(parseMessageIds('<a@x.example>, <b@x.example>')).toEqual(['<a@x.example>', '<b@x.example>']);
    expect(parseMessageIds(['<a@x.example>', 'b@x.example'])).toEqual(['<a@x.example>', '<b@x.example>']);
  });

  it('drops repeats, empties and anything that cannot be an id', () => {
    expect(parseMessageIds('<a@x.example> <a@x.example>')).toEqual(['<a@x.example>']);
    expect(parseMessageIds(['', null, undefined, '<>', '<a b@x.example>'])).toEqual([]);
    expect(parseMessageIds(undefined)).toEqual([]);
  });

  it('keeps the parent in the chain even when References left it out', () => {
    expect(referenceChain({ inReplyTo: '<b@x.example>', references: '<a@x.example>' })).toEqual({
      inReplyTo: '<b@x.example>',
      references: ['<a@x.example>', '<b@x.example>'],
    });
  });

  it('does not repeat a parent the chain already ends with', () => {
    expect(referenceChain({ inReplyTo: '<b@x.example>', references: ['<a@x.example>', '<b@x.example>'] })).toEqual({
      inReplyTo: '<b@x.example>',
      references: ['<a@x.example>', '<b@x.example>'],
    });
  });

  it('keeps the recent end of a long chain', () => {
    const many = Array.from({ length: 30 }, (_, i) => `<${i}@x.example>`);
    const { references } = referenceChain({ references: many });
    expect(references).toHaveLength(20);
    expect(references.at(-1)).toBe('<29@x.example>');
  });

  it('reads a message with neither header as the start of a conversation', () => {
    expect(referenceChain({})).toEqual({ inReplyTo: null, references: [] });
  });
});
