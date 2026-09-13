import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connect, disconnect, clearDb, signIn, makeThread } from './helpers.js';
import { createApp } from '../src/app.js';

const app = createApp();

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearDb);

const anna = { email: 'anna@sift.example', password: 'correct-horse', name: 'Anna' };
const ben = { email: 'ben@sift.example', password: 'correct-horse', name: 'Ben' };

const search = (who, query) => request(app).get('/api/search').query(query).set('Cookie', who.cookie);
const subjectsFor = async (who, q, extra = {}) =>
  (await search(who, { q, ...extra })).body.results.map((r) => r.thread.subject);

describe('GET /api/search', () => {
  it('requires a session', async () => {
    expect((await request(app).get('/api/search?q=Kaution')).status).toBe(401);
  });

  it('finds a conversation by a word in a message body and says which message matched', async () => {
    const a = await signIn(app, anna);
    await makeThread(a.user._id, [{ body: 'Die Kaution wird in zwei Wochen überwiesen' }], { subject: 'Wohnung' });
    await makeThread(a.user._id, [{ body: 'Etwas ganz anderes' }], { subject: 'Rechnung' });

    const res = await search(a, { q: 'Kaution' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const [hit] = res.body.results;
    expect(hit.thread.subject).toBe('Wohnung');
    expect(hit.match).toMatchObject({ snippet: 'Die Kaution wird in zwei Wochen überwiesen', folder: 'inbox' });
    expect(hit.match.messageId).toMatch(/^[a-f0-9]{24}$/);
    expect(hit.match.score).toBeGreaterThan(0);
  });

  it('ranks a match in the subject above a match only in the body', async () => {
    const a = await signIn(app, anna);
    // Mongo scores a match higher the shorter the field it sits in, so at equal
    // weight a one-word body beats a long subject. This only passes if the
    // subject weight is doing its job. The winner is created first, so that
    // newest-first order cannot produce the right answer by accident.
    await makeThread(a.user._id, [{ body: 'Bitte lesen' }], { subject: 'Kaution für die neue Wohnung in Berlin' });
    await makeThread(a.user._id, [{ body: 'Kaution' }], { subject: 'Allgemeines' });

    expect(await subjectsFor(a, 'Kaution')).toEqual(['Kaution für die neue Wohnung in Berlin', 'Allgemeines']);
  });

  it('matches other forms of a German word, with or without umlauts', async () => {
    const a = await signIn(app, anna);
    await makeThread(a.user._id, [{ body: 'Vielen Dank für Ihre Bewerbung' }], { subject: 'Eingang' });
    await makeThread(a.user._id, [{ body: 'Die Prüfungen beginnen im Januar' }], { subject: 'Termine' });

    expect(await subjectsFor(a, 'Bewerbungen')).toEqual(['Eingang']);
    expect(await subjectsFor(a, 'Prüfung')).toEqual(['Termine']);
    expect(await subjectsFor(a, 'Prufung')).toEqual(['Termine']);
  });

  // The next two pin down what keyword search cannot do. They are the baseline
  // stage 5 is measured against, so a change that made them pass by accident
  // would be worth noticing.
  it('does not find German mail from an English description of it', async () => {
    const a = await signIn(app, anna);
    await makeThread(a.user._id, [{ body: 'Die Kaution wird überwiesen' }], { subject: 'Wohnung' });
    expect(await subjectsFor(a, 'deposit')).toEqual([]);
  });

  it('does not split German compound words', async () => {
    const a = await signIn(app, anna);
    await makeThread(a.user._id, [{ body: 'Anbei die Nebenkostenabrechnung' }], { subject: 'Abrechnung' });
    expect(await subjectsFor(a, 'Nebenkosten')).toEqual([]);
  });

  it('lists a conversation once, shown through its best-matching message', async () => {
    const a = await signIn(app, anna);
    // The best match sits in the middle of the thread, so neither the first
    // nor the last message seen can be the one reported by accident.
    await makeThread(
      a.user._id,
      [
        { body: 'Eine längere Nachricht über Umzug, Möbel und am Ende die Kaution' },
        { body: 'Kaution' },
        { body: 'Noch einmal kurz zur Kaution und zum Schlüssel' },
      ],
      { subject: 'Viele Treffer' },
    );

    const res = await search(a, { q: 'Kaution' });
    expect(res.body.results.map((r) => r.thread.subject)).toEqual(['Viele Treffer']);
    expect(res.body.results[0].match.snippet).toBe('Kaution');
  });

  it('ranks a conversation by its best message, not by how many messages match', async () => {
    const a = await signIn(app, anna);
    // Winner first again, for the same reason as above.
    await makeThread(a.user._id, [{ body: 'Kurz' }], { subject: 'Kaution Rückzahlung' });
    await makeThread(
      a.user._id,
      Array.from({ length: 6 }, (_, i) => ({ body: `Nebenbei erwähnt: Kaution, Nachricht ${i}` })),
      { subject: 'Langer Verlauf' },
    );

    expect(await subjectsFor(a, 'Kaution')).toEqual(['Kaution Rückzahlung', 'Langer Verlauf']);
  });

  it('leaves out trash and spam but searches archive, sent and drafts', async () => {
    const a = await signIn(app, anna);
    for (const folder of ['inbox', 'archive', 'sent', 'drafts', 'trash', 'spam']) {
      await makeThread(a.user._id, [{ body: 'Kaution', folder, isDraft: folder === 'drafts', isRead: true }], {
        subject: folder,
      });
    }
    expect((await subjectsFor(a, 'Kaution')).sort()).toEqual(['archive', 'drafts', 'inbox', 'sent']);
  });

  it("never returns someone else's mail", async () => {
    const a = await signIn(app, anna);
    const b = await signIn(app, ben);
    await makeThread(b.user._id, [{ body: 'Die Kaution wird überwiesen' }], { subject: 'Bens Wohnung' });
    expect(await subjectsFor(a, 'Kaution')).toEqual([]);
  });

  it('returns no more conversations than the limit', async () => {
    const a = await signIn(app, anna);
    for (let i = 0; i < 5; i += 1) await makeThread(a.user._id, [{ body: `Kaution ${i}` }], { subject: `T${i}` });
    expect(await subjectsFor(a, 'Kaution', { limit: 2 })).toHaveLength(2);
  });

  it('supports quoted phrases and excluded words', async () => {
    const a = await signIn(app, anna);
    await makeThread(a.user._id, [{ body: 'Die Kaution wird überwiesen' }], { subject: 'Wohnung' });
    await makeThread(a.user._id, [{ body: 'Wird die Kaution je überwiesen' }], { subject: 'Frage' });
    await makeThread(a.user._id, [{ body: 'Kaution für das Auto' }], { subject: 'Auto' });

    expect(await subjectsFor(a, '"Kaution wird"')).toEqual(['Wohnung']);
    expect((await subjectsFor(a, 'Kaution -Auto')).sort()).toEqual(['Frage', 'Wohnung']);
  });

  it.each([
    ['only stop words', 'und die der'],
    ['only punctuation', '!!!'],
  ])('answers a query of %s with no results rather than an error', async (_label, q) => {
    const a = await signIn(app, anna);
    await makeThread(a.user._id, [{ body: 'und die der Kaution' }]);
    const res = await search(a, { q });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it.each([
    ['no query', {}, 'q'],
    ['a blank query', { q: '   ' }, 'q'],
    ['a query over 200 characters', { q: 'x'.repeat(201) }, 'q'],
    ['a limit over 50', { q: 'Kaution', limit: 51 }, 'limit'],
    ['the query given twice', { q: ['Kaution', 'Wohnung'] }, 'q'],
  ])('rejects %s', async (_label, query, field) => {
    const a = await signIn(app, anna);
    const res = await search(a, query);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });
});
