import { env } from '../../config/env.js';
import { createOllamaProvider } from './ollama.js';
import { createHostedProvider } from './hosted.js';

export { AiError } from './errors.js';

let current;

// The provider AI_PROVIDER picks, made once and shared.
export function getAi() {
  current ??=
    env.AI_PROVIDER === 'hosted'
      ? createHostedProvider()
      : createOllamaProvider({ host: env.OLLAMA_HOST, embeddingModel: env.EMBEDDING_MODEL, chatModel: env.CHAT_MODEL });
  return current;
}

// For tests, which hand in a fake. Passing nothing goes back to the one .env picks.
export function setAi(provider) {
  current = provider;
}
