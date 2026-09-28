// Every failure a provider reports, whichever model service is behind it, so
// the code calling it can decide what to do without knowing which one it is.
//
//   unavailable     the service could not be reached, or failed on its side
//   timeout         no answer in time
//   aborted         the caller cancelled
//   model_missing   the configured model is not there, and the message says
//                   how to get it
//   bad_request     the service refused the request as it was sent
//   bad_response    the answer was not what the contract promises
//   not_configured  the provider cannot run with the settings it was given
export class AiError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AiError';
    this.code = code;
    // Worth trying again later: the same request may well work next time.
    this.retryable = code === 'unavailable' || code === 'timeout';
  }
}
