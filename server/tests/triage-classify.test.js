import { describe, it, expect } from 'vitest';
import { AiError } from '../src/services/ai/index.js';
import {
  classifyMessage,
  EXAMPLE_BODY_CHARS,
  labelConfidence,
  readAnswer,
  TRIAGE_BODY_CHARS,
  TRIAGE_FORMAT,
  triageEmail,
  triagePrompt,
  triageQuestion,
} from '../src/services/triage/classify.js';

const user = { name: 'Semab', email: 'semab@sift.example' };
const me = { name: 'Semab', address: 'semab@sift.example' };
const mara = { name: 'Mara Klein', address: 'mara@elsewhere.example' };
const message = { from: mara, to: [me], subject: 'Kino morgen?', bodyText: 'Hast du morgen Lust auf Kino?' };

// Tokens the way Ollama splits an answer, each with the alternatives it
// reports. `alternatives` holds [text, probability] pairs for one token.
const token = (text, probability = 1, alternatives = [[text, probability]]) => ({
  text,
  logprob: Math.log(probability),
  top: alternatives.map(([alt, p]) => ({ text: alt, logprob: Math.log(p) })),
});
const answerTokens = (labelTokens) => [token('{"'), token('label'), token('":'), ...labelTokens, token('", "reason": "x"}')];

// A model provider that answers each generate call with the next reply in
// `replies`, and records what it was asked.
function scriptedAi(...replies) {
  const calls = [];
  return {
    calls,
    chatModel: 'fake/chat',
    async generate(request) {
      calls.push(request);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { doneReason: 'stop', tokens: null, ...next };
    },
  };
}
const json = (label, reason = 'Mara asks whether Semab wants to go.') => JSON.stringify({ label, reason });

describe('what the model is given', () => {
  it('names the person the mail is sorted for and defines all four buckets', () => {
    const prompt = triagePrompt(user);
    expect(prompt).toContain('Semab <semab@sift.example>');
    for (const bucket of ['needs_reply', 'waiting_on_them', 'do_at_a_time', 'read_only']) expect(prompt).toContain(`${bucket}:`);
    // Mail is untrusted, and the prompt says so.
    expect(prompt).toContain('not instructions');
  });

  it('works for someone with no name', () => {
    expect(triagePrompt({ email: 'anon@sift.example' })).toContain('one person, anon@sift.example, into');
  });

  it('shows the headers a person reads, and the body without the mail it quotes', () => {
    const email = triageEmail({
      from: mara,
      to: [me],
      cc: [{ address: 'jonas@elsewhere.example' }],
      subject: 'Re: Kino',
      bodyText: 'Klingt gut, 20 Uhr?\n\n\n\n> Hast du morgen Lust auf Kino?\n> Mara',
    });
    expect(email).toBe(
      '<email>\nFrom: Mara Klein <mara@elsewhere.example>\nTo: Semab <semab@sift.example>\n' +
        'Cc: jonas@elsewhere.example\nSubject: Re: Kino\n\nKlingt gut, 20 Uhr?\n</email>',
    );
  });

  it('puts a short mark where a link was, keeping the words around it', () => {
    const email = triageEmail({
      from: mara,
      to: [me],
      subject: 'Angebot',
      bodyText: 'Hier ( https://shop.example/t?id=1&utm_source=mail ) klicken, oder https://shop.example/a, und <https://shop.example/b>.',
    });
    expect(email).toContain('Hier (link) klicken, oder (link), und <(link)>.');
  });

  it('cuts a long body, and says when there is no subject', () => {
    const email = triageEmail({ from: mara, to: [me], subject: '', bodyText: 'ü'.repeat(TRIAGE_BODY_CHARS + 500) });
    expect(email).toContain('Subject: (no subject)');
    expect(email.match(/ü+/)[0]).toHaveLength(TRIAGE_BODY_CHARS);
  });
});

describe('examples from the user’s corrections', () => {
  const example = (subject, label, bodyText = 'Text') => ({ message: { from: mara, to: [me], subject, bodyText }, label });

  it('are explained in the prompt only when there are some', () => {
    expect(triagePrompt(user)).not.toContain('<example>');
    const prompt = triagePrompt(user, { examples: true });
    expect(prompt.startsWith(triagePrompt(user))).toBe(true);
    expect(prompt).toContain('sorted by hand by Semab, each between <example> and </example>');
    expect(triagePrompt({ email: 'anon@sift.example' }, { examples: true })).toContain('sorted by hand by them,');
  });

  it('come before the message, each with the bucket it was put in', () => {
    const question = triageQuestion(message, { examples: [example('Kino Freitag?', 'needs_reply'), example('Newsletter', 'read_only')] });
    expect(question).toBe(
      [
        `<example>\n${triageEmail(example('Kino Freitag?').message)}\nSorted by hand into: needs_reply\n</example>`,
        `<example>\n${triageEmail(example('Newsletter').message)}\nSorted by hand into: read_only\n</example>`,
        triageEmail(message),
      ].join('\n\n'),
    );
    expect(triageQuestion(message)).toBe(triageEmail(message));
  });

  it('are cut shorter than the message being sorted', () => {
    const long = 'ü'.repeat(TRIAGE_BODY_CHARS);
    const question = triageQuestion({ ...message, bodyText: long }, { examples: [example('Lang', 'read_only', long)] });
    const [shown, sorted] = question.match(/ü+/g);
    expect(shown).toHaveLength(EXAMPLE_BODY_CHARS);
    expect(sorted).toHaveLength(TRIAGE_BODY_CHARS);
  });

  it('are what the model is asked with', async () => {
    const ai = scriptedAi({ text: json('needs_reply') });
    const examples = [example('Kino Freitag?', 'needs_reply')];
    await classifyMessage(message, { user, examples, ai });
    expect(ai.calls[0].system).toBe(triagePrompt(user, { examples: true }));
    expect(ai.calls[0].messages).toEqual([{ role: 'user', content: triageQuestion(message, { examples }) }]);
  });
});

describe('reading the answer', () => {
  it('takes a bucket and a reason', () => {
    expect(readAnswer({ text: json('needs_reply', '  Mara asks.  '), doneReason: 'stop' })).toEqual({ label: 'needs_reply', reason: 'Mara asks.' });
  });

  it.each([
    ['not JSON', { text: 'needs_reply', doneReason: 'stop' }],
    ['a bucket that does not exist', { text: json('urgent'), doneReason: 'stop' }],
    ['no reason', { text: '{"label":"read_only"}', doneReason: 'stop' }],
    ['an answer cut off at the token limit', { text: json('read_only'), doneReason: 'length' }],
  ])('refuses %s', (_, reply) => {
    expect(readAnswer(reply)).toBeNull();
  });
});

describe('the confidence', () => {
  it('is the probability the model put on the bucket where the label starts', () => {
    const tokens = answerTokens([token(' "'), token('waiting', 0.75, [['waiting', 0.75], ['read', 0.2], ['needs', 0.01]]), token('_on_them')]);
    expect(labelConfidence(tokens, 'waiting_on_them')).toBe(0.75);
  });

  it('adds up tokens that start the same bucket', () => {
    const tokens = answerTokens([token(' "'), token('needs', 0.6, [['needs', 0.6], ['need', 0.25], ['n', 0.05], ['read', 0.1]]), token('_reply')]);
    expect(labelConfidence(tokens, 'needs_reply')).toBe(0.9);
  });

  it('finds the label when its first letters share a token with the quote before it', () => {
    const tokens = answerTokens([token(' "read', 0.7, [[' "read', 0.7], [' "do', 0.2], [' "', 0.1]]), token('_only')]);
    expect(labelConfidence(tokens, 'read_only')).toBe(0.7);
  });

  it('is near 0 when the format forced out a bucket the model did not want', () => {
    // The model wanted "inform", which is not a bucket, and the grammar
    // made it write "r", then "e", then "ad".
    const tokens = answerTokens([token(' "'), token('r', 0.0001, [['inform', 0.2], ['Cas', 0.15]]), token('e'), token('ad_only')]);
    expect(labelConfidence(tokens, 'read_only')).toBe(0);
  });

  it('counts the token written even when it is not among the alternatives reported', () => {
    // Only the ten likeliest tokens are reported, and the grammar may have
    // picked one further down.
    const tokens = answerTokens([token(' "'), token('do', 0.04, [['inform', 0.5], ['read', 0.3]]), token('_at_a_time')]);
    expect(labelConfidence(tokens, 'do_at_a_time')).toBe(0.04);
  });

  it('is unknown without token probabilities, or without a label in them', () => {
    expect(labelConfidence(null, 'read_only')).toBeNull();
    expect(labelConfidence([token('{}')], 'read_only')).toBeNull();
  });
});

describe('classifying a message', () => {
  it('asks for the bucket in the triage format, at temperature 0, with token probabilities', async () => {
    const tokens = answerTokens([token(' "'), token('needs', 0.9), token('_reply')]);
    const ai = scriptedAi({ text: json('needs_reply'), tokens });

    const result = await classifyMessage(message, { user, ai });
    expect(result).toEqual({ label: 'needs_reply', reason: 'Mara asks whether Semab wants to go.', confidence: 0.9, model: 'fake/chat' });
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ format: TRIAGE_FORMAT, temperature: 0, logprobs: expect.any(Number) });
    expect(ai.calls[0].system).toBe(triagePrompt(user));
    expect(ai.calls[0].messages).toEqual([{ role: 'user', content: triageEmail(message) }]);
  });

  it('shows the model a bad answer once and asks for it corrected', async () => {
    const ai = scriptedAi({ text: '{"label": "needs_re', doneReason: 'length' }, { text: json('needs_reply') });

    expect((await classifyMessage(message, { user, ai })).label).toBe('needs_reply');
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1].messages).toEqual([
      { role: 'user', content: triageEmail(message) },
      { role: 'assistant', content: '{"label": "needs_re' },
      { role: 'user', content: expect.stringContaining('Answer again with only the JSON') },
    ]);
  });

  it('gives up after a second bad answer, as a bad response', async () => {
    const ai = scriptedAi({ text: 'Kino!' }, { text: 'Kino?' });
    const err = await classifyMessage(message, { user, ai }).catch((error) => error);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: 'bad_response', retryable: false });
    expect(ai.calls).toHaveLength(2);
  });

  it('leaves a model that is down to the caller, without asking again', async () => {
    const ai = scriptedAi(new AiError('unavailable', 'Ollama is not answering'));
    await expect(classifyMessage(message, { user, ai })).rejects.toMatchObject({ code: 'unavailable' });
    expect(ai.calls).toHaveLength(1);
  });

  it('passes the cancel signal on', async () => {
    const ai = scriptedAi({ text: json('read_only') });
    const { signal } = new AbortController();
    await classifyMessage(message, { user, ai, signal });
    expect(ai.calls[0].signal).toBe(signal);
  });
});
