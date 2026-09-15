import { afterAll, beforeAll } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { server } from './server.js';
import { fakeAuthApi, fakeMailApi } from './fake-api.js';
import { SELF, makeThread } from './mail-fixtures.js';
import { ROW_HEIGHT } from '../features/mail/thread-list.jsx';

export const VIEWPORT_ROWS = 10;

// jsdom does no layout. Every element measures 0 by 0, so a virtual list
// decides that no rows fit, and cannot scroll either: it stops a scroll at
// scrollHeight minus clientHeight, which is 0. Elements also have no scrollTo.
// These stand in for the browser during one test file, and are put back after it.
export function giveElementsASize() {
  const viewport = VIEWPORT_ROWS * ROW_HEIGHT;
  const patches = {
    offsetHeight: { configurable: true, get: () => viewport },
    offsetWidth: { configurable: true, get: () => 400 },
    clientHeight: { configurable: true, get: () => viewport },
    // As tall as the tallest child with a height set, which for the list's
    // scroll area is the list itself.
    scrollHeight: {
      configurable: true,
      get() {
        return Math.max(viewport, ...[...this.children].map((child) => parseFloat(child.style?.height) || 0));
      },
    },
    scrollTo: {
      configurable: true,
      writable: true,
      value(options) {
        if (options?.top !== undefined) this.scrollTop = options.top;
        this.dispatchEvent(new Event('scroll'));
      },
    },
  };
  const originals = Object.fromEntries(
    Object.keys(patches).map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
  );

  beforeAll(() => {
    for (const [name, descriptor] of Object.entries(patches)) Object.defineProperty(HTMLElement.prototype, name, descriptor);
  });

  afterAll(() => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete HTMLElement.prototype[name];
    }
  });
}

// Signed in as Semab, with this mailbox behind the fake API.
export function serve(fixtures) {
  const auth = fakeAuthApi();
  auth.state.signedIn = SELF.address;
  const mail = fakeMailApi(fixtures);
  server.use(...auth.handlers, ...mail.handlers);
  return mail;
}

export const findList = (title) => screen.findByRole('list', { name: `Conversations in ${title}` });

export const numbered = (count) => Array.from({ length: count }, (_, i) => makeThread({ subject: `Nachricht ${i + 1}` }));

export function scrollToRow(list, row) {
  const scroller = list.parentElement;
  scroller.scrollTop = row * ROW_HEIGHT;
  fireEvent.scroll(scroller);
}
