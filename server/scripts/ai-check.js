import { env } from '../src/config/env.js';
import { getAi } from '../src/services/ai/index.js';

// Checks the model provider .env points at, the way the rest of Sift will use
// it: a few embeddings, a streamed answer, and an answer held to a JSON schema.
// Prints what each took, so a slow or missing model shows up here first.
//
//   npm run ai:check --workspace=server

const ai = getAi();
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const ms = (start) => `${Math.round(performance.now() - start)} ms`;

console.log(`provider ${ai.name}, embeddings from ${ai.embeddingModel}, answers from ${ai.chatModel}`);
if (ai.name === 'ollama') console.log(`at ${env.OLLAMA_HOST}`);

try {
  let start = performance.now();
  const documents = [
    'Die Kaution für die Wohnung wird Ende des Monats zurücküberwiesen.',
    'Your deposit will be refunded to your account at the end of the month.',
    'Die Prüfungsanmeldung für Maschinelles Lernen endet am Freitag.',
  ];
  const [german, english, exam] = await ai.embed(documents);
  const [query] = await ai.embed(['when do I get my deposit back'], { purpose: 'query' });
  console.log(`\nembed: ${documents.length + 1} vectors of ${query.length} numbers in ${ms(start)}`);
  console.log(`  the deposit question against the German deposit mail  ${dot(query, german).toFixed(3)}`);
  console.log(`  the deposit question against the English deposit mail ${dot(query, english).toFixed(3)}`);
  console.log(`  the deposit question against the exam mail            ${dot(query, exam).toFixed(3)}`);
  const sensible = dot(query, german) > dot(query, exam) && dot(query, english) > dot(query, exam);
  console.log(`  ${sensible ? 'both deposit mails rank above the exam mail' : 'CHECK: the exam mail ranks above a deposit mail'}`);

  start = performance.now();
  let first = null;
  process.stdout.write('\ngenerate: ');
  const answer = await ai.generate({
    system: 'You answer in one short sentence.',
    messages: [{ role: 'user', content: 'What is an email thread, in plain words?' }],
    onText: (piece) => {
      first ??= performance.now();
      process.stdout.write(piece);
    },
  });
  const seconds = (performance.now() - start) / 1000;
  console.log(`\n  first text after ${Math.round(first - start)} ms, all of it in ${seconds.toFixed(1)} s`);
  console.log(`  ${answer.usage.inputTokens} tokens in, ${answer.usage.outputTokens} out, ended by ${answer.doneReason}`);

  start = performance.now();
  const schema = {
    type: 'object',
    properties: { needsReply: { type: 'boolean' }, reason: { type: 'string' } },
    required: ['needsReply', 'reason'],
  };
  const classified = await ai.generate({
    system: 'Decide whether the email asks the reader to reply. Answer with JSON only.',
    messages: [{ role: 'user', content: 'Hi Semab, can you send me the signed contract by Friday? Thanks, Mara' }],
    format: schema,
    temperature: 0,
  });
  console.log(`\ngenerate with a schema, in ${ms(start)}: ${JSON.stringify(JSON.parse(classified.text))}`);
} catch (err) {
  console.error(`\nfailed (${err.code ?? err.name}): ${err.message}`);
  process.exitCode = 1;
}
