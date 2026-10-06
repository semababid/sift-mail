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
// to fail only that many calls before working again.
export function fakeAi(model = 'fake/embedder') {
  const calls = [];
  const state = { delayMs: 0, fail: null, failTimes: Infinity };
  return {
    calls,
    state,
    name: 'fake',
    embeddingModel: model,
    chatModel: null,
    async embed(texts, { purpose } = {}) {
      calls.push({ texts: [...texts], purpose });
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.fail && state.failTimes > 0) {
        state.failTimes -= 1;
        throw new AiError(state.fail, `the model failed (${state.fail})`);
      }
      return texts.map(vectorFor);
    },
    generate: async () => {
      throw new Error('not used here');
    },
  };
}
