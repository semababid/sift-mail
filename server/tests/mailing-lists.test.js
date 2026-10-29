import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { simpleParser } from 'mailparser';
import { connect, disconnect, clearDb, signIn } from './helpers.js';
import { createApp } from '../src/app.js';
import { mailingListOf } from '../src/lib/headers.js';
import { Message } from '../src/models/index.js';
import { setAi } from '../src/services/ai/index.js';
import { fetchPendingBodies, importNewMail, readMailingLists } from '../src/services/imap/importer.js';
import { triageEmail } from '../src/services/triage/classify.js';
import { flushTriage } from '../src/services/triage/queue.js';
import { flushEmbeddings } from '../src/services/embedding/queue.js';
import { ACCOUNT, MARA, fakeMailbox, mail } from './imap-fixtures.js';
import { fakeAi } from './fake-ai.js';

const app = createApp();

beforeAll(connect);
afterAll(async () => {
  setAi(undefined);
  await disconnect();
});

const headersOf = async (...lines) => (await simpleParser([...lines, 'Subject: x', '', 'Hallo'].join('\r\n'))).headers;
const NEWSLETTER = ['List-Id: "Shop News" <news.shop.example>', 'List-Unsubscribe: <https://shop.example/u>'];

describe('reading the mailing list headers', () => {
  it('names the list its List-Id gives', async () => {
    expect(mailingListOf(await headersOf(...NEWSLETTER))).toEqual({ bulk: true, listName: 'Shop News' });
  });

  it('falls back to the list id when the List-Id has no name', async () => {
    expect(mailingListOf(await headersOf('List-Id: <news.shop.example>'))).toEqual({ bulk: true, listName: 'news.shop.example' });
  });

  it('counts an unsubscribe link alone, or a bulk precedence, as a list without a name', async () => {
    expect(mailingListOf(await headersOf('List-Unsubscribe: <mailto:off@shop.example>'))).toEqual({ bulk: true, listName: null });
    expect(mailingListOf(await headersOf('Precedence: Bulk'))).toEqual({ bulk: true, listName: null });
    expect(mailingListOf(await headersOf('Precedence: list'))).toEqual({ bulk: true, listName: null });
  });

  it('says no for mail a person wrote, even one marked urgent', async () => {
    expect(mailingListOf(await headersOf('Precedence: urgent'))).toEqual({ bulk: false, listName: null });
    expect(mailingListOf(await headersOf())).toEqual({ bulk: false, listName: null });
    expect(mailingListOf(undefined)).toEqual({ bulk: false, listName: null });
  });

  it('cuts a very long list name', async () => {
    const { listName } = mailingListOf(await headersOf(`List-Id: "${'N'.repeat(500)}" <n.example>`));
    expect(listName).toHaveLength(120);
  });
});

describe('the model sees it', () => {
  const message = { from: MARA, to: [], subject: 'Sale', bodyText: 'Jetzt kaufen.' };

  it('as a line under the subject, with the list’s name or without', () => {
    expect(triageEmail({ ...message, bulk: true, listName: 'Shop News' })).toContain('Subject: Sale\nMailing list: Shop News\n');
    expect(triageEmail({ ...message, bulk: true, listName: null })).toContain('Subject: Sale\nMailing list: yes\n');
  });

  it('not at all for mail that is not from a list, or that nobody has checked', () => {
    expect(triageEmail({ ...message, bulk: false })).not.toContain('Mailing list');
    expect(triageEmail({ ...message, bulk: null })).not.toContain('Mailing list');
  });
});

describe('imported mail', () => {
  let owner;
  let ai;
  beforeEach(async () => {
    await flushTriage();
    await flushEmbeddings();
    await clearDb();
    ai = fakeAi();
    setAi(ai);
    owner = await signIn(app);
  });

  const importAll = async (mailbox) => {
    await importNewMail({ user: owner.user, client: mailbox.client, account: ACCOUNT });
    await fetchPendingBodies({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
  };
  const stored = (uid) => Message.findOne({ 'imap.uid': uid }).lean();
  const readOld = (mailbox, uidValidity = '7') =>
    readMailingLists({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity });

  it('is marked as from a list, or not, when its text arrives', async () => {
    const mailbox = fakeMailbox([mail(1, { extraHeaders: NEWSLETTER }), mail(2)]);
    await importAll(mailbox);
    expect(await stored(1)).toMatchObject({ bulk: true, listName: 'Shop News' });
    expect(await stored(2)).toMatchObject({ bulk: false, listName: null });
  });

  it('reaches the model with the list on it', async () => {
    await importAll(fakeMailbox([mail(1, { extraHeaders: NEWSLETTER })]));
    await flushTriage();
    expect(ai.asked[0].messages[0].content).toContain('Mailing list: Shop News');
  });

  it('stays unchecked when its text could not be fetched', async () => {
    const mailbox = fakeMailbox([mail(1, { extraHeaders: NEWSLETTER })]);
    await importNewMail({ user: owner.user, client: mailbox.client, account: ACCOUNT });
    mailbox.box.delete(1);
    await fetchPendingBodies({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
    expect(await stored(1)).toMatchObject({ bodyStatus: 'unavailable', bulk: null });
  });

  describe('imported before Sift read the headers', () => {
    // As it was stored then: text in, list unknown, and sorted by the model.
    async function importedEarlier(mailbox, uid, intent = { label: 'do_at_a_time', source: 'model', classifiedAt: new Date() }) {
      await importAll(mailbox);
      await flushTriage();
      await Message.updateOne({ 'imap.uid': uid }, { $set: { bulk: null, listName: null, intent } });
      ai.asked.length = 0;
    }

    it('gets its list read from the headers alone, and is sorted again knowing it', async () => {
      const mailbox = fakeMailbox([mail(1, { extraHeaders: NEWSLETTER })]);
      await importedEarlier(mailbox, 1);

      expect(await readOld(mailbox)).toBe(1);
      expect(await stored(1)).toMatchObject({ bulk: true, listName: 'Shop News', intent: { classifiedAt: null } });
      await flushTriage();
      expect(ai.asked).toHaveLength(1);
      expect(ai.asked[0].messages[0].content).toContain('Mailing list: Shop News');
      expect(await stored(1)).toMatchObject({ intent: { source: 'model', label: 'read_only', classifiedAt: expect.any(Date) } });
    });

    it('keeps the model’s bucket when the mail turns out not to be from a list', async () => {
      const mailbox = fakeMailbox([mail(1)]);
      await importedEarlier(mailbox, 1);

      await readOld(mailbox);
      await flushTriage();
      expect(ai.asked).toEqual([]);
      expect(await stored(1)).toMatchObject({ bulk: false, intent: { label: 'do_at_a_time', classifiedAt: expect.any(Date) } });
    });

    it('never undoes a bucket the user chose', async () => {
      const mailbox = fakeMailbox([mail(1, { extraHeaders: NEWSLETTER })]);
      const chosenAt = new Date(Date.UTC(2026, 4, 2));
      await importedEarlier(mailbox, 1, { label: 'needs_reply', source: 'user', classifiedAt: chosenAt });

      await readOld(mailbox);
      await flushTriage();
      expect(ai.asked).toEqual([]);
      expect(await stored(1)).toMatchObject({ bulk: true, intent: { label: 'needs_reply', source: 'user', classifiedAt: chosenAt } });
    });

    it('marks mail the server no longer has as not from a list, so it is not asked about again', async () => {
      const mailbox = fakeMailbox([mail(1, { extraHeaders: NEWSLETTER })]);
      await importedEarlier(mailbox, 1);
      mailbox.box.delete(1);

      expect(await readOld(mailbox)).toBe(1);
      expect(await stored(1)).toMatchObject({ bulk: false });
      expect(await readOld(mailbox)).toBe(0);
    });

    it('never fetches by a UID from before the mailbox was reset', async () => {
      const mailbox = fakeMailbox([mail(1, { extraHeaders: NEWSLETTER })]);
      await importedEarlier(mailbox, 1);
      mailbox.state.sourceRequests.length = 0;

      expect(await readOld(mailbox, '8')).toBe(0);
      expect(mailbox.state.sourceRequests).toEqual([]);
    });

    it('reads a batch at a time, and nothing once all are read', async () => {
      const mailbox = fakeMailbox(Array.from({ length: 25 }, (_, i) => mail(i + 1)));
      await importAll(mailbox);
      for (let more = 1; more > 0; ) more = await fetchPendingBodies({ user: owner.user, client: mailbox.client, account: ACCOUNT, uidValidity: '7' });
      await Message.updateMany({}, { $set: { bulk: null } });

      expect(await readOld(mailbox)).toBe(20);
      expect(await readOld(mailbox)).toBe(5);
      expect(await readOld(mailbox)).toBe(0);
    });
  });
});
