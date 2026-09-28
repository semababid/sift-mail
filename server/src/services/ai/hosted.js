import { AiError } from './errors.js';

// The place for a hosted model service, which production needs because Ollama
// will not run on a free hosting tier. Which service, and its embed and
// generate calls, come in stage 10.3. Until then every call fails at once
// with a message saying so, before a missing model can cause a stranger error
// in search or triage.
export function createHostedProvider() {
  const notYet = async () => {
    throw new AiError('not_configured', 'the hosted model provider is not built yet. Set AI_PROVIDER=ollama in .env');
  };
  return { name: 'hosted', embeddingModel: null, chatModel: null, embed: notYet, generate: notYet };
}
