import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { EMBEDDING_DIMS } from '../src/lib/constants.js';
import { createOllamaProvider } from '../src/services/ai/ollama.js';
import { createHostedProvider } from '../src/services/ai/hosted.js';
import { getAi, setAi, AiError } from '../src/services/ai/index.js';

// A stand-in for Ollama's HTTP API. Each test sets `handle` to answer the way
// it needs, and every request is kept in `received`.
let server;
let host;
let handle;
let received;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    received.push({ path: req.url, body });
    handle(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  received = [];
  handle = (req, res) => json(res, 500, { error: 'no handler set' });
});

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Streams chat lines the way Ollama does, one JSON object per line. `pieces`
// splits the raw text at those points instead, to test lines that arrive in
// parts.
async function stream(res, lines, { delayMs = 0, pieces } = {}) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const raw = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
  const parts = pieces ? cut(raw, pieces) : raw.split(/(?<=\n)/);
  for (const part of parts) {
    res.write(part);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  res.end();
}
const cut = (text, size) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'));

const chunk = (content) => ({ model: 'test-chat-model', message: { role: 'assistant', content }, done: false });
const done = (extra = {}) => ({ model: 'test-chat-model', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3, ...extra });

// A vector of the right size that is not yet of length 1.
const rawVector = (seed) => Array.from({ length: EMBEDDING_DIMS }, (_, i) => ((i * 7 + seed) % 11) - 5);
const length = (vector) => Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));

const provider = (overrides = {}) =>
  createOllamaProvider({ host, embeddingModel: 'nomic-embed-text', chatModel: 'test-chat-model', ...overrides });

// Runs `promise` and answers the AiError it rejects with.
async function failureOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a failure');
}

describe('embed', () => {
  it('labels stored mail for the model, and hands back one unit vector per text, in order', async () => {
    handle = (req, res, body) => json(res, 200, { embeddings: body.input.map((_, i) => rawVector(i)) });

    const vectors = await provider().embed(['Die Kaution kommt zurück.', 'Termin am Freitag']);
    expect(received).toEqual([
      {
        path: '/api/embed',
        body: {
          model: 'nomic-embed-text',
          input: ['search_document: Die Kaution kommt zurück.', 'search_document: Termin am Freitag'],
          truncate: true,
        },
      },
    ]);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_DIMS);
      expect(length(vector)).toBeCloseTo(1, 10);
    }
    // Same direction as what the model sent, only scaled.
    expect(vectors[0][1] / vectors[0][0]).toBeCloseTo(rawVector(0)[1] / rawVector(0)[0], 10);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });

  it('labels a search as a query', async () => {
    handle = (req, res, body) => json(res, 200, { embeddings: body.input.map(() => rawVector(1)) });
    await provider().embed(['wann kommt die Kaution'], { purpose: 'query' });
    expect(received[0].body.input).toEqual(['search_query: wann kommt die Kaution']);
  });

  it('sends text as it is to a model that takes no label', async () => {
    handle = (req, res, body) => json(res, 200, { embeddings: body.input.map(() => rawVector(1)) });
    await provider({ embeddingModel: 'mxbai-embed-large:latest' }).embed(['Kaution']);
    expect(received[0].body).toMatchObject({ model: 'mxbai-embed-large:latest', input: ['Kaution'] });
  });

  it('knows a model by its name whatever tag or namespace it has', async () => {
    handle = (req, res, body) => json(res, 200, { embeddings: body.input.map(() => rawVector(1)) });
    await provider({ embeddingModel: 'library/nomic-embed-text:v1.5' }).embed(['Kaution']);
    expect(received[0].body.input).toEqual(['search_document: Kaution']);
  });

  it('asks for nothing when there is nothing to embed', async () => {
    expect(await provider().embed([])).toEqual([]);
    expect(received).toEqual([]);
  });

  it('refuses a purpose it does not know, and anything but strings, before sending', async () => {
    await expect(provider().embed(['x'], { purpose: 'summary' })).rejects.toThrow(TypeError);
    await expect(provider().embed([42])).rejects.toThrow(TypeError);
    expect(received).toEqual([]);
  });

  it('names its vectors after the service and the model', () => {
    expect(provider().embeddingModel).toBe('ollama/nomic-embed-text');
  });

  it('says the size is wrong, and what to change, when the model makes vectors of another size', async () => {
    handle = (req, res) => json(res, 200, { embeddings: [Array(512).fill(0.1)] });
    const err = await failureOf(provider().embed(['x']));
    expect(err).toMatchObject({ code: 'not_configured', retryable: false });
    expect(err.message).toContain(`vectors of 512 numbers, but Sift is set up for ${EMBEDDING_DIMS}`);
  });

  it('expects a size of its own when a comparison of models asks for one', async () => {
    handle = (req, res) => json(res, 200, { embeddings: [Array(512).fill(0.1)] });
    const [vector] = await provider({ embeddingModel: 'klein-embed', dims: 512 }).embed(['x']);
    expect(vector).toHaveLength(512);
  });

  it.each([
    ['fewer vectors than texts', { embeddings: [rawVector(1)] }],
    ['no vectors at all', { something: 'else' }],
    ['a vector with something that is not a number', { embeddings: [[...rawVector(1).slice(1), 'x'], rawVector(2)] }],
    ['a vector of zeros', { embeddings: [Array(EMBEDDING_DIMS).fill(0), rawVector(2)] }],
  ])('rejects an answer with %s', async (_case, answer) => {
    handle = (req, res) => json(res, 200, answer);
    expect(await failureOf(provider().embed(['a', 'b']))).toMatchObject({ code: 'bad_response' });
  });
});

describe('generate', () => {
  it('sends the conversation with thinking off, and answers with the text and the counts', async () => {
    handle = (req, res) => stream(res, [chunk('Ber'), chunk('lin'), done()]);

    const answer = await provider().generate({
      system: 'Answer in one word.',
      messages: [{ role: 'user', content: 'Capital of Germany?' }],
      temperature: 0,
      maxTokens: 20,
    });

    expect(answer).toEqual({ text: 'Berlin', doneReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 }, tokens: null });
    expect(received).toEqual([
      {
        path: '/api/chat',
        body: {
          model: 'test-chat-model',
          messages: [
            { role: 'system', content: 'Answer in one word.' },
            { role: 'user', content: 'Capital of Germany?' },
          ],
          stream: true,
          think: false,
          options: { temperature: 0, num_predict: 20 },
        },
      },
    ]);
  });

  it('asks for logprobs only when told to, and answers every token with its alternatives', async () => {
    const withLogprobs = (content, alternatives) => ({
      ...chunk(content),
      logprobs: [{ token: content, logprob: alternatives[0][1], bytes: [], top_logprobs: alternatives.map(([token, logprob]) => ({ token, logprob, bytes: [] })) }],
    });
    handle = (req, res) =>
      stream(res, [withLogprobs('read', [['read', -0.1], ['needs', -2.4]]), withLogprobs('_only', [['_only', -0.01]]), done()]);

    const answer = await provider().generate({ messages: [{ role: 'user', content: 'x' }], logprobs: 2 });
    expect(received[0].body).toMatchObject({ logprobs: true, top_logprobs: 2 });
    expect(answer.tokens).toEqual([
      { text: 'read', logprob: -0.1, top: [{ text: 'read', logprob: -0.1 }, { text: 'needs', logprob: -2.4 }] },
      { text: '_only', logprob: -0.01, top: [{ text: '_only', logprob: -0.01 }] },
    ]);

    await provider().generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(received[1].body).not.toHaveProperty('logprobs');
    expect(received[1].body).not.toHaveProperty('top_logprobs');
  });

  it('answers tokens: null when Ollama sends no logprobs, as an older version does', async () => {
    handle = (req, res) => stream(res, [chunk('Ja'), done()]);
    const answer = await provider().generate({ messages: [{ role: 'user', content: 'x' }], logprobs: 5 });
    expect(answer).toMatchObject({ text: 'Ja', tokens: null });
  });

  it('refuses a logprobs count Ollama would not take', async () => {
    for (const logprobs of [0, 21, 2.5, '5']) {
      await expect(provider().generate({ messages: [{ role: 'user', content: 'x' }], logprobs })).rejects.toThrow(TypeError);
    }
    expect(received).toEqual([]);
  });

  it('hands each piece to onText as it arrives', async () => {
    handle = (req, res) => stream(res, [chunk('eins, '), chunk('zwei, '), chunk('drei'), done()], { delayMs: 20 });
    const pieces = [];

    const answer = await provider().generate({ messages: [{ role: 'user', content: 'Zähl bis drei' }], onText: (piece) => pieces.push(piece) });
    expect(pieces).toEqual(['eins, ', 'zwei, ', 'drei']);
    expect(answer.text).toBe('eins, zwei, drei');
  });

  it('puts lines back together when they arrive in parts', async () => {
    // A pause after each piece, or the network joins them into one chunk and
    // nothing is ever cut mid-line.
    handle = (req, res) => stream(res, [chunk('Grüße '), chunk('aus Cottbus'), done()], { pieces: 7, delayMs: 5 });
    const answer = await provider().generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(answer.text).toBe('Grüße aus Cottbus');
  });

  it('keeps a letter whole when its bytes arrive in two chunks', async () => {
    handle = async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const bytes = Buffer.from(`${JSON.stringify(chunk('Grüße'))}\n${JSON.stringify(done())}\n`);
      // "ü" is two bytes in UTF-8. Cut between them.
      const middle = bytes.indexOf(Buffer.from('ü')) + 1;
      res.write(bytes.subarray(0, middle));
      await new Promise((resolve) => setTimeout(resolve, 20));
      res.end(bytes.subarray(middle));
    };
    const answer = await provider().generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(answer.text).toBe('Grüße');
  });

  it('passes a JSON schema on as the format the answer must follow', async () => {
    const schema = { type: 'object', properties: { bucket: { type: 'string', enum: ['needs_reply', 'read_only'] } }, required: ['bucket'] };
    handle = (req, res) => stream(res, [chunk('{"bucket":"needs_reply"}'), done()]);

    const answer = await provider().generate({ messages: [{ role: 'user', content: 'x' }], format: schema });
    expect(received[0].body.format).toEqual(schema);
    expect(JSON.parse(answer.text)).toEqual({ bucket: 'needs_reply' });
  });

  it('leaves the format out for plain text, and uses a mild temperature unless told otherwise', async () => {
    handle = (req, res) => stream(res, [chunk('ok'), done()]);
    await provider().generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(received[0].body).not.toHaveProperty('format');
    expect(received[0].body.options).toEqual({ temperature: 0.2 });
  });

  it('says when the answer stopped at the token limit', async () => {
    handle = (req, res) => stream(res, [chunk('Es war einmal'), done({ done_reason: 'length' })]);
    const answer = await provider().generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 3 });
    expect(answer.doneReason).toBe('length');
  });

  it('refuses messages that are not a conversation, before sending', async () => {
    await expect(provider().generate({ messages: [] })).rejects.toThrow(TypeError);
    await expect(provider().generate({ messages: [{ role: 'system', content: 'x' }] })).rejects.toThrow(TypeError);
    await expect(provider().generate({})).rejects.toThrow(TypeError);
    expect(received).toEqual([]);
  });

  it('reports a failure that arrives partway through the answer', async () => {
    handle = (req, res) => stream(res, [chunk('Anfang'), { error: 'model runner has unexpectedly stopped' }]);
    const err = await failureOf(provider().generate({ messages: [{ role: 'user', content: 'x' }] }));
    expect(err).toMatchObject({ code: 'unavailable', retryable: true });
    expect(err.message).toContain('model runner has unexpectedly stopped');
  });

  it('rejects an answer that ends without finishing', async () => {
    handle = (req, res) => stream(res, [chunk('Anfang')]);
    expect(await failureOf(provider().generate({ messages: [{ role: 'user', content: 'x' }] }))).toMatchObject({
      code: 'bad_response',
    });
  });

  it('rejects a line that is not JSON', async () => {
    handle = (req, res) => stream(res, [chunk('Anfang'), 'kein json', done()]);
    expect(await failureOf(provider().generate({ messages: [{ role: 'user', content: 'x' }] }))).toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('when Ollama cannot help', () => {
  it('says how to get a model that is not there', async () => {
    handle = (req, res) => json(res, 404, { error: 'model "nomic-embed-text" not found, try pulling it first' });
    const err = await failureOf(provider().embed(['x']));
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: 'model_missing', retryable: false });
    expect(err.message).toContain('ollama pull nomic-embed-text');
  });

  it('passes on why Ollama refused a request', async () => {
    handle = (req, res) => json(res, 400, { error: '"nomic-embed-text" does not support chat' });
    const err = await failureOf(provider({ chatModel: 'nomic-embed-text' }).generate({ messages: [{ role: 'user', content: 'x' }] }));
    expect(err).toMatchObject({ code: 'bad_request', retryable: false });
    expect(err.message).toContain('does not support chat');
  });

  it('treats a failure on Ollama’s side as worth trying again', async () => {
    handle = (req, res) => json(res, 500, { error: 'out of memory' });
    expect(await failureOf(provider().embed(['x']))).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('says how to start Ollama when nothing is listening', async () => {
    const err = await failureOf(provider({ host: 'http://127.0.0.1:9' }).embed(['x']));
    expect(err).toMatchObject({ code: 'unavailable', retryable: true });
    expect(err.message).toContain('ollama serve');
  });

  it('gives up on an embed that takes too long', async () => {
    handle = () => {};
    const err = await failureOf(provider({ embedTimeoutMs: 100 }).embed(['x']));
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('gives up on an answer that stalls halfway, not only one that never starts', async () => {
    handle = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(chunk('Anfang'))}\n`);
    };
    const pieces = [];
    const err = await failureOf(
      provider({ generateTimeoutMs: 200 }).generate({ messages: [{ role: 'user', content: 'x' }], onText: (p) => pieces.push(p) }),
    );
    expect(err).toMatchObject({ code: 'timeout' });
    expect(pieces).toEqual(['Anfang']);
  });

  it('stops when the caller cancels, and does not count it as worth retrying', async () => {
    handle = (req, res) => stream(res, [chunk('eins'), chunk('zwei'), chunk('drei'), done()], { delayMs: 100 });
    const controller = new AbortController();
    const pieces = [];

    const pending = provider().generate({
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
      onText: (piece) => {
        pieces.push(piece);
        controller.abort();
      },
    });
    expect(await failureOf(pending)).toMatchObject({ code: 'aborted', retryable: false });
    expect(pieces).toEqual(['eins']);
  });

  it('passes on an error from onText as it was, rather than blaming Ollama', async () => {
    handle = (req, res) => stream(res, [chunk('eins'), chunk('zwei'), done()], { delayMs: 20 });
    const closed = new Error('the browser went away');

    const err = await failureOf(
      provider().generate({
        messages: [{ role: 'user', content: 'x' }],
        onText: () => {
          throw closed;
        },
      }),
    );
    expect(err).toBe(closed);
  });
});

describe('the hosted placeholder', () => {
  it('says plainly that it is not there yet', async () => {
    const hosted = createHostedProvider();
    for (const call of [hosted.embed(['x']), hosted.generate({ messages: [{ role: 'user', content: 'x' }] })]) {
      const err = await failureOf(call);
      expect(err).toMatchObject({ code: 'not_configured' });
      expect(err.message).toContain('AI_PROVIDER=ollama');
    }
  });
});

describe('choosing the provider', () => {
  it('builds the one .env names, once, and lets a test swap it', () => {
    setAi(undefined);
    const first = getAi();
    expect(first).toMatchObject({ name: 'ollama', embeddingModel: 'ollama/bge-m3', chatModel: 'test-chat-model' });
    expect(getAi()).toBe(first);

    const fake = { name: 'fake' };
    setAi(fake);
    expect(getAi()).toBe(fake);
    setAi(undefined);
  });
});
