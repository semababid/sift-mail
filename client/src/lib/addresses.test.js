import { describe, expect, it } from 'vitest';
import { formatAddressList, parseAddressList } from './addresses.js';

describe('parseAddressList', () => {
  it('splits on commas, semicolons and line breaks, lowercasing and dropping repeats', () => {
    expect(parseAddressList(' Mara@Sift.example, jonas@sift.example;\nmara@sift.example ')).toEqual({
      addresses: ['mara@sift.example', 'jonas@sift.example'],
      invalid: [],
    });
  });

  it('keeps the address out of "Name <address>"', () => {
    expect(parseAddressList('Mara Klein <Mara@Sift.example>').addresses).toEqual(['mara@sift.example']);
  });

  it('returns what cannot be an address, as it was typed', () => {
    expect(parseAddressList('mara@sift.example, jonas@, lena, a@b')).toEqual({
      addresses: ['mara@sift.example'],
      invalid: ['jonas@', 'lena', 'a@b'],
    });
  });

  it('reads an empty field as no addresses at all', () => {
    expect(parseAddressList('  , ;')).toEqual({ addresses: [], invalid: [] });
  });
});

describe('formatAddressList', () => {
  it('joins addresses the way the field shows them', () => {
    expect(formatAddressList(['mara@sift.example', 'jonas@sift.example'])).toBe('mara@sift.example, jonas@sift.example');
    expect(formatAddressList([])).toBe('');
  });
});
