import { setupServer } from 'msw/node';

// One request interceptor for the whole run. Each test adds the handlers it
// needs, and they are cleared again after it.
export const server = setupServer();
