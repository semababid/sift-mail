import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connect, disconnect, clearDb } from './helpers.js';
import { User, Thread, Message, Label } from '../src/models/index.js';

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

const objectId = () => new mongoose.Types.ObjectId();

describe('User', () => {
  it('lowercases and trims the email', async () => {
    const user = await User.create({ email: '  Semab@B-TU.de ', passwordHash: 'x', name: 'S' });
    expect(user.email).toBe('semab@b-tu.de');
  });

  it('strips the password hash from JSON even when it was loaded', async () => {
    const created = await User.create({ email: 'a@b.de', passwordHash: 'secret-hash', name: 'A' });
    const json = (await User.findById(created._id).select('+passwordHash')).toJSON();

    expect(json).not.toHaveProperty('passwordHash');
    expect(json).not.toHaveProperty('_id');
    expect(json).not.toHaveProperty('__v');
    expect(json.id).toBe(created._id.toString());
  });

  it('rejects a second account with the same email in any case', async () => {
    await User.create({ email: 'a@b.de', passwordHash: 'x', name: 'A' });
    await expect(User.create({ email: 'A@B.de', passwordHash: 'y', name: 'B' })).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe('Message', () => {
  const base = () => ({
    userId: objectId(),
    threadId: objectId(),
    from: { address: 'LL@Example.com' },
    sentAt: new Date(),
  });

  it('lowercases addresses and fills the intent defaults', async () => {
    const message = await Message.create(base());
    expect(message.from.address).toBe('ll@example.com');
    expect(message.toObject().intent).toEqual({
      label: null,
      confidence: null,
      source: 'default',
      classifiedAt: null,
    });
  });

  it('keeps the embedding out of normal queries and out of JSON', async () => {
    const created = await Message.create({ ...base(), embedding: Array.from({ length: 768 }, () => 0.1) });

    const plain = await Message.findById(created._id);
    expect(plain.embedding).toBeUndefined();

    const withVector = await Message.findById(created._id).select('+embedding');
    expect(withVector.embedding).toHaveLength(768);
    expect(withVector.toJSON()).not.toHaveProperty('embedding');
  });

  it('rejects a folder that does not exist', async () => {
    await expect(Message.create({ ...base(), folder: 'nonsense' })).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });
});

describe('Thread', () => {
  it('populates labels through labelIds', async () => {
    const userId = objectId();
    const label = await Label.create({ userId, name: 'Wohnung' });
    const thread = await Thread.create({ userId, lastMessageAt: new Date(), labelIds: [label._id] });

    const populated = await Thread.findById(thread._id).populate('labelIds');
    expect(populated.labelIds[0].name).toBe('Wohnung');
  });
});
