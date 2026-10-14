import { EMBEDDING_DIMS } from '../../lib/constants.js';
import { AiError } from './errors.js';
import { checkEmbedInput, checkGenerateInput, checkVector } from './contract.js';

// The provider for a local Ollama, over its HTTP API. See contract.js for
// what each call promises.

// Some embedding models were trained with a task label in front of every
// input, and search is worse without it. nomic-embed-text is one.
// Models not listed here take text as it is.
const TASK_PREFIXES = {
  'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' },
};
const baseName = (model) => model.split(':')[0].split('/').pop();

// A model the size of Sift's chat model can take most of a minute just to
// load, the first time it is used after a while.
const EMBED_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 180_000;

// An error thrown by the caller's own onText, carried out of the stream so it
// reaches the caller as it was. Turned into an AiError it would blame Ollama
// for, say, a browser that closed the connection mid-answer.
class CallerError {
  constructor(err) {
    this.err = err;
  }
}

export function createOllamaProvider({
  host,
  embeddingModel,
  chatModel,
  // The vector size to expect. Only a comparison of models sets it; Sift
  // itself stores vectors of EMBEDDING_DIMS.
  dims = EMBEDDING_DIMS,
  embedTimeoutMs = EMBED_TIMEOUT_MS,
  generateTimeoutMs = GENERATE_TIMEOUT_MS,
}) {
  // Which of the two gave up: the caller, or the clock.
  function failure(err, { signal, timeout, timeoutMs }) {
    if (err instanceof AiError) return err;
    if (err instanceof CallerError) return err.err;
    if (signal?.aborted) return new AiError('aborted', 'the request was cancelled', { cause: err });
    if (timeout.aborted) return new AiError('timeout', `Ollama did not answer within ${timeoutMs / 1000} s`, { cause: err });
    return new AiError('unavailable', `Ollama is not answering at ${host}. Start it with: ollama serve`, { cause: err });
  }

  // Ollama explains a refusal in an { error } body. A model that is not there
  // gets a message that says how to get it.
  async function refusal(res, model) {
    const detail = await res
      .json()
      .then((body) => body?.error)
      .catch(() => null);
    if (res.status === 404) {
      return new AiError('model_missing', `the model "${model}" is not in Ollama. Get it with: ollama pull ${model}`);
    }
    if (res.status >= 500) return new AiError('unavailable', `Ollama failed: ${detail ?? res.status}`);
    return new AiError('bad_request', `Ollama refused the request for "${model}": ${detail ?? res.status}`);
  }

  // Sends one request and hands the response to `read`. The clock runs until
  // the body has been read, not just until the headers arrive: a streamed
  // answer that stalls halfway is as stuck as one that never started.
  async function request(path, body, { model, signal, timeoutMs, read }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(new URL(path, host), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: both,
      });
      if (!res.ok) throw await refusal(res, model);
      return await read(res);
    } catch (err) {
      throw failure(err, { signal, timeout, timeoutMs });
    }
  }

  // Ollama streams one JSON object per line.
  async function* lines(res) {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of res.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line) yield parseLine(line);
      }
    }
    const rest = (buffered + decoder.decode()).trim();
    if (rest) yield parseLine(rest);
  }

  function parseLine(line) {
    try {
      return JSON.parse(line);
    } catch {
      throw new AiError('bad_response', `Ollama sent a line that is not JSON: ${line.slice(0, 80)}`);
    }
  }

  return {
    name: 'ollama',
    embeddingModel: `ollama/${embeddingModel}`,
    chatModel,

    async embed(texts, { purpose = 'document', signal } = {}) {
      checkEmbedInput(texts, purpose);
      if (texts.length === 0) return [];
      const prefix = TASK_PREFIXES[baseName(embeddingModel)]?.[purpose] ?? '';

      return request(
        '/api/embed',
        // Ollama cuts an input longer than the model reads at its limit.
        { model: embeddingModel, input: texts.map((text) => prefix + text), truncate: true },
        {
          model: embeddingModel,
          signal,
          timeoutMs: embedTimeoutMs,
          read: async (res) => {
            const body = await res.json().catch(() => null);
            const vectors = body?.embeddings;
            if (!Array.isArray(vectors) || vectors.length !== texts.length) {
              throw new AiError('bad_response', `Ollama sent ${vectors?.length ?? 'no'} vectors for ${texts.length} texts`);
            }
            return vectors.map((vector) => checkVector(vector, embeddingModel, dims));
          },
        },
      );
    },

    async generate({ system, messages, format, temperature = 0.2, maxTokens, onText, signal } = {}) {
      checkGenerateInput({ messages });

      return request(
        '/api/chat',
        {
          model: chatModel,
          messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
          // Always streamed, so the timeout covers the whole answer and there
          // is one way of reading it whether or not the caller wants pieces.
          stream: true,
          // Models that can think before answering do so by default. With
          // qwen3.5:9b that turns a one-word answer from a third of a second
          // into 10 s. Nothing in Sift reads the thinking, so it is off.
          think: false,
          format,
          options: { temperature, ...(maxTokens ? { num_predict: maxTokens } : {}) },
        },
        {
          model: chatModel,
          signal,
          timeoutMs: generateTimeoutMs,
          read: async (res) => {
            let text = '';
            let last = null;
            for await (const line of lines(res)) {
              // A failure after the answer has started comes as a line of its own.
              if (line.error) throw new AiError('unavailable', `Ollama failed partway: ${line.error}`);
              const piece = line.message?.content ?? '';
              if (piece) {
                text += piece;
                try {
                  onText?.(piece);
                } catch (err) {
                  throw new CallerError(err);
                }
              }
              if (line.done) last = line;
            }
            if (!last) throw new AiError('bad_response', 'Ollama stopped before the answer was finished');
            return {
              text,
              doneReason: last.done_reason === 'length' ? 'length' : 'stop',
              usage: { inputTokens: last.prompt_eval_count ?? 0, outputTokens: last.eval_count ?? 0 },
            };
          },
        },
      );
    },
  };
}
