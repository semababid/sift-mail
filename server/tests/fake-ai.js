import crypto from 'node:crypto';
import { EMBEDDING_DIMS } from '../src/lib/constants.js';
import { AiError } from '../src/services/ai/index.js';

// A unit vector made from the text, so the same text always gets the same one.
export function vectorFor(text) {
  const seed = crypto.createHash('sha256').update(text).digest();
  const raw = Array.from({ length: EMBEDDING_DIMS }, (_, i) => seed[i % seed.length] - 128 + (i % 7));
  const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0));
  return raw.map((x) => x / norm);
}

// A model provider that records every call. Set `state.delayMs` to make it
// slow, `state.fail` to an AiError code to make it fail, or `state.failTimes`
// to fail only that many calls before working again. Both calls share those.
//
// generate() answers as the triage classifier asks: with the bucket that
// `state.bucket(request)` picks, read_only unless set, or with whatever text
// `state.answer(request)` gives instead. It is cancelled by its signal, and
// every request is kept in `asked`.
export function fakeAi(model = 'fake/embedder') {
  const calls = [];
  const asked = [];
  const state = { delayMs: 0, fail: null, failTimes: Infinity, bucket: () => 'read_only', answer: null };

  async function behave(signal) {
    if (state.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, state.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new AiError('aborted', 'the request was cancelled'));
        });
      });
    }
    if (state.fail && state.failTimes > 0) {
      state.failTimes -= 1;
      throw new AiError(state.fail, `the model failed (${state.fail})`);
    }
  }

  return {
    calls,
    asked,
    state,
    name: 'fake',
    embeddingModel: model,
    chatModel: 'fake/chat',
    async embed(texts, { purpose } = {}) {
      calls.push({ texts: [...texts], purpose });
      await behave();
      return texts.map(vectorFor);
    },
    async generate(request) {
      asked.push(request);
      await behave(request.signal);
      const text = state.answer?.(request) ?? JSON.stringify({ label: state.bucket(request), reason: 'Fake reason.' });
      return { text, doneReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 }, tokens: null };
    },
  };
}
