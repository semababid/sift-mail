import { describe, expect, it } from 'vitest';
import { conversationWith, listDate, personName } from './format.js';

const SELF = 'semab@sift.example';
const me = { name: 'Semab', address: SELF };
const mara = { name: 'Mara Klein', address: 'mara@sift.example' };

describe('listDate', () => {
  const now = new Date(2026, 4, 15, 16, 30);

  it('shows the time for mail from today', () => {
    expect(listDate(new Date(2026, 4, 15, 9, 5).toISOString(), now)).toBe('09:05');
  });

  it('shows day and month for yesterday, however late it arrived', () => {
    expect(listDate(new Date(2026, 4, 14, 23, 59), now)).toBe('14 May');
  });

  it('shows day and month for earlier this year', () => {
    expect(listDate(new Date(2026, 2, 3), now)).toBe('3 Mar');
  });

  it('shows the full date for an earlier year', () => {
    expect(listDate(new Date(2025, 11, 31, 23, 0), now)).toBe('31/12/2025');
  });
});

describe('personName', () => {
  it('uses the name, then the address, and calls the signed-in user me', () => {
    expect(personName(mara, SELF)).toBe('Mara Klein');
    expect(personName({ name: '', address: 'noreply@bank.example' }, SELF)).toBe('noreply@bank.example');
    expect(personName(me, SELF)).toBe('me');
  });
});

describe('conversationWith', () => {
  it('names the one other person in full', () => {
    expect(conversationWith([mara, me], SELF)).toBe('Mara Klein');
  });

  it('says me for mail only to yourself', () => {
    expect(conversationWith([me], SELF)).toBe('me');
  });

  it('uses first names, or the start of the address, for several people', () => {
    const jonas = { name: 'Jonas Weber', address: 'jonas@sift.example' };
    const unnamed = { address: 'pruefungsamt@uni.example' };
    expect(conversationWith([mara, me, jonas, unnamed], SELF)).toBe('Mara, Jonas, pruefungsamt');
  });

  it('counts everyone past the third', () => {
    const people = ['Anna', 'Ben', 'Cem', 'Dana', 'Emil'].map((name) => ({ name, address: `${name}@sift.example` }));
    expect(conversationWith([me, ...people], SELF)).toBe('Anna, Ben, Cem +2');
  });
});
