import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn, makeThread, threadSummaryProblems } from './helpers.js';
import { createApp } from '../src/app.js';
import { Thread } from '../src/models/index.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

const anna = { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' };
const ben = { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' };

const labels = (who) => ({
  list: () => request(app).get('/api/labels').set('Cookie', who.cookie),
  create: (body) => request(app).post('/api/labels').set('Cookie', who.cookie).send(body),
  update: (id, body) => request(app).patch(`/api/labels/${id}`).set('Cookie', who.cookie).send(body),
  remove: (id) => request(app).delete(`/api/labels/${id}`).set('Cookie', who.cookie),
});

const act = (who, ids, action, labelId) =>
  request(app)
    .post('/api/threads/batch')
    .set('Cookie', who.cookie)
    .send({ ids: ids.map(String), action, ...(labelId ? { labelId: String(labelId) } : {}) });

const threadsIn = (who, query) => request(app).get('/api/threads').query(query).set('Cookie', who.cookie);

async function newLabel(who, name) {
  return (await labels(who).create({ name })).body.label.id;
}

describe('labels', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/labels')).status).toBe(401);
  });

  it('creates a label without exposing its internal key', async () => {
    const a = await signIn(app, anna);
    const res = await labels(a).create({ name: 'Wohnung', color: '#0ea5e9' });

    expect(res.status).toBe(201);
    expect(res.body.label).toMatchObject({ name: 'Wohnung', color: '#0ea5e9' });
    expect(res.body.label).toHaveProperty('id');
    expect(res.body.label).not.toHaveProperty('nameKey');
  });

  it('gives a label the default colour when none is chosen', async () => {
    const a = await signIn(app, anna);
    expect((await labels(a).create({ name: 'Uni' })).body.label.color).toBe('#6b7280');
  });

  it('refuses a second label whose name differs only in case or spacing', async () => {
    const a = await signIn(app, anna);
    await labels(a).create({ name: 'Uni' });

    for (const name of ['uni', '  UNI  ']) {
      const res = await labels(a).create({ name });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('label_exists');
    }
  });

  it('lets two users give labels the same name', async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    expect((await labels(a).create({ name: 'Uni' })).status).toBe(201);
    expect((await labels(b).create({ name: 'Uni' })).status).toBe(201);
  });

  it.each([
    ['a blank name', { name: '   ' }, 'name'],
    ['a name over 50 characters', { name: 'x'.repeat(51) }, 'name'],
    ['a colour that is not hex', { name: 'Uni', color: 'blue' }, 'color'],
    ['no name at all', {}, 'name'],
  ])('rejects %s', async (_label, body, field) => {
    const a = await signIn(app, anna);
    const res = await labels(a).create(body);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });

  it('rejects unknown fields', async () => {
    const a = await signIn(app, anna);
    expect((await labels(a).create({ name: 'Uni', parent: 'x' })).status).toBe(400);
  });

  it('renames a label, including to a different case of its own name, and recolours it', async () => {
    const a = await signIn(app, anna);
    const id = await newLabel(a, 'uni');

    const renamed = await labels(a).update(id, { name: 'Uni' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.label.name).toBe('Uni');

    const recoloured = await labels(a).update(id, { color: '#ef4444' });
    expect(recoloured.body.label).toMatchObject({ name: 'Uni', color: '#ef4444' });
  });

  it('refuses renaming one label onto another, whatever the case', async () => {
    const a = await signIn(app, anna);
    await newLabel(a, 'Uni');
    const arbeit = await newLabel(a, 'Arbeit');

    const res = await labels(a).update(arbeit, { name: 'UNI' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('label_exists');
    expect((await labels(a).list()).body.labels.map((l) => l.name)).toEqual(['Arbeit', 'Uni']);
  });

  it("answers someone else's label, a made-up id and a malformed id with the same 404", async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    const bens = await newLabel(b, 'Privat');

    for (const id of [bens, new mongoose.Types.ObjectId().toString(), 'not-an-id']) {
      expect((await labels(a).update(id, { name: 'meins' })).status).toBe(404);
      expect((await labels(a).remove(id)).status).toBe(404);
    }
    expect((await labels(b).list()).body.labels.map((l) => l.name)).toEqual(['Privat']);
  });

  it('lists labels in German alphabetical order', async () => {
    const a = await signIn(app, anna);
    for (const name of ['Zahlungen', 'Überweisung', 'Arbeit', 'ärztlich']) await newLabel(a, name);

    const names = (await labels(a).list()).body.labels.map((l) => l.name);
    expect(names).toEqual(['Arbeit', 'ärztlich', 'Überweisung', 'Zahlungen']);
  });

  it('counts conversations and unread conversations per label, leaving out trashed ones', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const empty = await newLabel(a, 'Leer');
    const labelIds = [new mongoose.Types.ObjectId(uni)];

    await makeThread(a.user._id, [{ folder: 'inbox' }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'inbox', isRead: true }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'trash' }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'inbox', isRead: true }, { folder: 'trash', isRead: true }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'inbox' }]);

    const byName = Object.fromEntries((await labels(a).list()).body.labels.map((l) => [l.name, l]));
    expect(byName.Uni).toMatchObject({ threadCount: 3, unreadCount: 1 });
    expect(byName.Leer).toMatchObject({ id: empty, threadCount: 0, unreadCount: 0 });
  });
});

describe('applying labels', () => {
  it('adds a label to a selection once however often it is applied, and removes it again', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const first = await makeThread(a.user._id, [{}]);
    const second = await makeThread(a.user._id, [{}]);

    await act(a, [first, second], 'addLabel', uni);
    const again = await act(a, [first, second], 'addLabel', uni);
    expect(again.status).toBe(200);
    expect(again.body.threads.map((t) => t.labelIds)).toEqual([[uni], [uni]]);

    const removed = await act(a, [first, second], 'removeLabel', uni);
    expect(removed.body.threads.map((t) => t.labelIds)).toEqual([[], []]);
  });

  it('leaves the conversation itself alone', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const id = await makeThread(a.user._id, [{ isRead: true }, {}]);
    const before = await Thread.findById(id).lean();

    await act(a, [id], 'addLabel', uni);
    const after = await Thread.findById(id).lean();
    expect(after).toMatchObject({
      lastMessageAt: before.lastMessageAt,
      snippet: before.snippet,
      hasUnread: before.hasUnread,
      folders: before.folders,
    });
    expect(await threadSummaryProblems(id)).toEqual([]);
  });

  it("refuses a label that is not the user's, and changes nothing", async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    const bens = await newLabel(b, 'Privat');
    const id = await makeThread(a.user._id, [{}]);

    const res = await act(a, [id], 'addLabel', bens);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect((await Thread.findById(id).lean()).labelIds).toEqual([]);
  });

  it("ignores threads that are not the user's, as the other actions do", async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    const uni = await newLabel(a, 'Uni');
    const mine = await makeThread(a.user._id, [{}]);
    const theirs = await makeThread(b.user._id, [{}]);

    const res = await act(a, [theirs, mine], 'addLabel', uni);
    expect(res.body.threads.map((t) => t.id)).toEqual([String(mine)]);
    expect((await Thread.findById(theirs).lean()).labelIds).toEqual([]);
  });

  it.each([
    ['a label action with no labelId', { action: 'addLabel' }],
    ['a labelId on an action that does not take one', { action: 'archive', labelId: '0123456789abcdef01234567' }],
  ])('rejects %s', async (_label, extra) => {
    const a = await signIn(app, anna);
    const res = await request(app)
      .post('/api/threads/batch')
      .set('Cookie', a.cookie)
      .send({ ids: ['0123456789abcdef01234567'], ...extra });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty('labelId');
  });
});

describe('label views', () => {
  it('lists every conversation with the label wherever it lives, newest first, except fully trashed ones', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const labelIds = [new mongoose.Types.ObjectId(uni)];
    const now = Date.now();

    const inbox = await makeThread(a.user._id, [{ folder: 'inbox', at: now - 5 * 60_000 }], { labelIds });
    const archived = await makeThread(a.user._id, [{ folder: 'archive', at: now - 4 * 60_000 }], { labelIds });
    const sent = await makeThread(a.user._id, [{ folder: 'sent', isRead: true, at: now - 3 * 60_000 }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'trash', at: now - 2 * 60_000 }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'inbox', at: now - 60_000 }]);

    const res = await threadsIn(a, { label: uni });
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t) => t.id)).toEqual([sent, archived, inbox].map(String));
  });

  it('narrows to one folder when a folder is given as well', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const labelIds = [new mongoose.Types.ObjectId(uni)];
    const inbox = await makeThread(a.user._id, [{ folder: 'inbox' }], { labelIds });
    await makeThread(a.user._id, [{ folder: 'archive' }], { labelIds });

    const res = await threadsIn(a, { label: uni, folder: 'inbox' });
    expect(res.body.threads.map((t) => t.id)).toEqual([String(inbox)]);
  });

  it('pages through a label view with the cursor', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const labelIds = [new mongoose.Types.ObjectId(uni)];
    for (let i = 0; i < 5; i += 1) await makeThread(a.user._id, [{ folder: i % 2 ? 'archive' : 'inbox' }], { labelIds });

    const seen = [];
    let cursor;
    do {
      const res = await threadsIn(a, { label: uni, limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...res.body.threads.map((t) => t.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
  });

  it("shows nothing for a label that is not the user's", async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    const bens = await newLabel(b, 'Privat');
    await makeThread(b.user._id, [{}], { labelIds: [new mongoose.Types.ObjectId(bens)] });

    const res = await threadsIn(a, { label: bens });
    expect(res.status).toBe(200);
    expect(res.body.threads).toEqual([]);
  });

  it('rejects a malformed label id', async () => {
    const a = await signIn(app, anna);
    const res = await threadsIn(a, { label: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty('label');
  });
});

describe('deleting a label', () => {
  it('takes it off every thread it was on', async () => {
    const a = await signIn(app, anna);
    const uni = await newLabel(a, 'Uni');
    const arbeit = await newLabel(a, 'Arbeit');
    const both = await makeThread(a.user._id, [{}], {
      labelIds: [new mongoose.Types.ObjectId(uni), new mongoose.Types.ObjectId(arbeit)],
    });
    const onlyUni = await makeThread(a.user._id, [{}], { labelIds: [new mongoose.Types.ObjectId(uni)] });

    expect((await labels(a).remove(uni)).status).toBe(204);

    expect((await Thread.findById(both).lean()).labelIds.map(String)).toEqual([arbeit]);
    expect((await Thread.findById(onlyUni).lean()).labelIds).toEqual([]);
    expect((await labels(a).list()).body.labels.map((l) => l.name)).toEqual(['Arbeit']);
    expect((await threadsIn(a, { label: uni })).body.threads).toEqual([]);
  });
});
