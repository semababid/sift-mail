import { describe, it, expect } from 'vitest';
import { EMBED_BODY_CHARS, embeddingText } from '../src/lib/embedding-text.js';

describe('embeddingText', () => {
  it('puts the subject first, then the body on one line', () => {
    expect(embeddingText({ subject: ' Kaution ', bodyText: 'Hallo Semab,\n\ndie Kaution kommt\nnächste Woche.' })).toBe(
      'Kaution\n\nHallo Semab, die Kaution kommt nächste Woche.',
    );
  });

  it('leaves out lines quoted from earlier mail', () => {
    const reply = 'Ja, passt.\n\nAm Montag schrieb Mara:\n> Kommst du am Freitag?\n  > > Und die Schlüssel?';
    expect(embeddingText({ subject: 'Re: Termin', bodyText: reply })).toBe('Re: Termin\n\nJa, passt. Am Montag schrieb Mara:');
  });

  it(`keeps the first ${EMBED_BODY_CHARS} characters of a long body`, () => {
    const text = embeddingText({ subject: 'Lang', bodyText: 'x'.repeat(EMBED_BODY_CHARS + 500) });
    expect(text).toBe(`Lang\n\n${'x'.repeat(EMBED_BODY_CHARS)}`);
  });

  it('counts the limit after the quotes are gone, so a long quote cannot crowd out the reply', () => {
    const bodyText = `${'> alt\n'.repeat(2000)}Neue Antwort`;
    expect(embeddingText({ subject: 'Re: x', bodyText })).toBe('Re: x\n\nNeue Antwort');
  });

  it('manages with only one of the two', () => {
    expect(embeddingText({ subject: 'Nur Betreff', bodyText: '' })).toBe('Nur Betreff');
    expect(embeddingText({ subject: '', bodyText: 'Nur Text' })).toBe('Nur Text');
    expect(embeddingText({})).toBe('');
  });
});
