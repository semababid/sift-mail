import { EMBEDDING_DIMS } from '../../lib/constants.js';
import { AiError } from './errors.js';

// What every model provider gives the rest of Sift. Search, triage, summaries
// and the inbox chat all go through these two calls, so the model service
// behind them can change without anything else changing.
//
// provider.name            "ollama", "hosted"
// provider.embeddingModel  names the vectors this provider makes, as
//                          "ollama/bge-m3". Stored with every vector,
//                          because vectors from two models cannot be compared.
// provider.chatModel       the model generate() uses
//
// embed(texts, { purpose, signal }) -> number[][]
//   One vector per text, in the same order. Each has the provider's `dims`
//   numbers, which is EMBEDDING_DIMS unless a caller asked for a model of
//   another size, and a length of 1, so the similarity of two vectors is their
//   dot product.
//   `purpose` is "document" for mail being stored and "query" for what
//   someone searched for. Some models are trained to embed the two
//   differently, and search is worse if they are mixed up.
//
// generate({ system, messages, format, temperature, maxTokens, logprobs, onText, signal })
//   -> { text, doneReason, usage: { inputTokens, outputTokens }, tokens }
//   `messages` is the conversation so far, as { role: "user" | "assistant",
//   content }. `format` is left out for plain text, "json" for any JSON, or a
//   JSON schema the answer must follow. `onText` gets each piece of text as it
//   arrives, for streaming; the promise still resolves with all of it.
//   `doneReason` is "length" when the answer stopped at maxTokens, which
//   usually means it was cut off, and "stop" otherwise.
//   `logprobs`, a number from 1 to 20, asks for `tokens`: every token of the
//   answer as { text, logprob, top }, where `top` is that many tokens the
//   model rated most likely at that point, each { text, logprob }. A
//   provider that cannot give them answers `tokens: null`, so callers must
//   work without. Without `logprobs`, `tokens` is null too.
//   With a `format`, the answer is held to it by a grammar that runs after
//   the model has rated its tokens, so `top` says what the model wanted and
//   may hold tokens the grammar did not allow.
//
// Both reject with an AiError. Both take an AbortSignal to cancel.

export const PURPOSES = ['document', 'query'];

// Checks a vector against the contract and scales it to length 1. Providers
// run what they get back through this, so a model change that alters the size
// fails loudly here instead of quietly filling the database with vectors the
// search index cannot use.
export function checkVector(vector, model, dims = EMBEDDING_DIMS) {
  if (!Array.isArray(vector) || !vector.every(Number.isFinite)) {
    throw new AiError('bad_response', `${model} answered with something that is not a vector`);
  }
  if (vector.length !== dims) {
    throw new AiError(
      'not_configured',
      `${model} makes vectors of ${vector.length} numbers, but Sift is set up for ${dims}. ` +
        'Change EMBEDDING_DIMS in lib/constants.js to match, and rebuild the vector index.',
    );
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) throw new AiError('bad_response', `${model} answered with a vector of zeros`);
  return vector.map((x) => x / norm);
}

// The checks every provider makes on what it was asked, before any request.
export function checkEmbedInput(texts, purpose) {
  if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string')) {
    throw new TypeError('embed() takes an array of strings');
  }
  if (!PURPOSES.includes(purpose)) throw new TypeError(`embed() purpose must be one of ${PURPOSES.join(', ')}`);
}

export function checkGenerateInput({ messages }) {
  const valid =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  if (!valid) throw new TypeError('generate() takes messages as [{ role: "user" | "assistant", content }], at least one');
}
