import { describe, expect, it } from 'vitest';
import { keyName } from './shortcuts.js';

const press = (key, modifiers = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });

describe('keyName', () => {
  it('names plain keys as they are', () => {
    expect(keyName(press('j'), { mac: false })).toBe('j');
    expect(keyName(press('Escape'), { mac: true })).toBe('Escape');
  });

  it('keeps keys that need shift, such as ?', () => {
    expect(keyName(press('?', { shiftKey: true }), { mac: false })).toBe('?');
  });

  it('reads Command as mod on a Mac, and leaves Control alone there', () => {
    expect(keyName(press('k', { metaKey: true }), { mac: true })).toBe('mod+k');
    expect(keyName(press('k', { ctrlKey: true }), { mac: true })).toBeNull();
  });

  it('reads Control as mod elsewhere, and leaves the Windows key alone', () => {
    expect(keyName(press('K', { ctrlKey: true, shiftKey: true }), { mac: false })).toBe('mod+k');
    expect(keyName(press('k', { metaKey: true }), { mac: false })).toBeNull();
  });

  it('gives no name to anything held with Alt', () => {
    expect(keyName(press('j', { altKey: true }), { mac: false })).toBeNull();
    expect(keyName(press('k', { altKey: true, metaKey: true }), { mac: true })).toBeNull();
  });
});
