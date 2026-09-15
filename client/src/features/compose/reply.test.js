import { describe, expect, it } from 'vitest';
import { messageDate } from '../../lib/format.js';
import { quoteMessage, replyRecipients, replySubject } from './reply.js';

const SELF = 'semab@sift.example';
const me = { name: 'Semab', address: SELF };
const mara = { name: 'Mara Klein', address: 'mara@sift.example' };
const jonas = { name: 'Jonas Weber', address: 'jonas@sift.example' };
const lena = { name: 'Lena Roth', address: 'lena@sift.example' };

const message = (overrides) => ({ from: mara, to: [me], cc: [], subject: '', bodyText: '', sentAt: '2026-04-30T09:00:00.000Z', ...overrides });

describe('replySubject', () => {
  it.each([
    ['Mietvertrag', 'Re: Mietvertrag'],
    ['AW: Re:  Mietvertrag', 'Re: Mietvertrag'],
    ['WG[2]: Fwd: Nebenkosten  2025', 'Re: Nebenkosten 2025'],
    ['re:re:Hallo', 'Re: Hallo'],
    ['', ''],
    ['Re:', ''],
  ])('%j becomes %j', (subject, expected) => {
    expect(replySubject(subject)).toBe(expected);
  });
});

describe('replyRecipients', () => {
  it('answers the sender of someone else’s message', () => {
    expect(replyRecipients(message({ to: [me, jonas], cc: [lena] }), SELF)).toEqual({ to: ['mara@sift.example'], cc: [] });
  });

  it('adds everyone else for reply all, leaving yourself out and listing nobody twice', () => {
    const received = message({ to: [me, jonas, mara], cc: [lena, me, jonas] });
    expect(replyRecipients(received, SELF, { all: true })).toEqual({
      to: ['mara@sift.example', 'jonas@sift.example'],
      cc: ['lena@sift.example'],
    });
  });

  it('follows up with the recipients of a message you sent', () => {
    const sent = message({ from: me, to: [mara, jonas], cc: [lena] });
    expect(replyRecipients(sent, SELF)).toEqual({ to: ['mara@sift.example', 'jonas@sift.example'], cc: [] });
    expect(replyRecipients(sent, SELF, { all: true })).toEqual({
      to: ['mara@sift.example', 'jonas@sift.example'],
      cc: ['lena@sift.example'],
    });
  });

  it('answers a note to yourself to yourself', () => {
    expect(replyRecipients(message({ from: me, to: [me] }), SELF)).toEqual({ to: [SELF], cc: [] });
  });
});

describe('quoteMessage', () => {
  const header = (who) => `\n\nOn ${messageDate('2026-04-30T09:00:00.000Z')}, ${who} wrote:\n`;

  it('marks every line, empty lines included, under who wrote it and when', () => {
    expect(quoteMessage(message({ bodyText: 'Hallo Semab,\r\n\r\nbis morgen.\n\n' }))).toBe(
      `${header('Mara Klein')}> Hallo Semab,\n>\n> bis morgen.`,
    );
  });

  it('nests lines that were already quoted', () => {
    expect(quoteMessage(message({ bodyText: 'Ja.\n> Kommst du?' }))).toBe(`${header('Mara Klein')}> Ja.\n>> Kommst du?`);
  });

  it('names the sender by address when there is no name, and says when there was no text', () => {
    expect(quoteMessage(message({ from: { address: 'noreply@bank.example' } }))).toBe(
      `${header('noreply@bank.example')}> (This message has no plain text.)`,
    );
  });
});
