import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { server } from '../../test/server.js';
import { fakeAuthApi, fakeMailApi } from '../../test/fake-api.js';
import { MARA, SELF, makeMessage, makeThread } from '../../test/mail-fixtures.js';
import { renderApp } from '../../test/render.jsx';
import { ROW_HEIGHT } from './thread-list.jsx';

// jsdom does no layout, so every element measures 0 by 0 and a virtual list
// decides that no rows fit. Giving elements a height lets the list work out
// what is in view the way it does in a browser.
const VIEWPORT_ROWS = 10;
const measured = ['offsetHeight', 'offsetWidth'];
const original = Object.fromEntries(
  measured.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => VIEWPORT_ROWS * ROW_HEIGHT });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 400 });
});

afterAll(() => {
  for (const name of measured) Object.defineProperty(HTMLElement.prototype, name, original[name]);
});

const UNI = { id: 'label-uni', name: 'Uni', color: '#0ea5e9', threadCount: 1, unreadCount: 1 };
const WOHNUNG = { id: 'label-wohnung', name: 'Wohnung', color: '#16a34a', threadCount: 0, unreadCount: 0 };

// Signed in as Semab, with this mailbox behind the fake API.
function serve(fixtures) {
  const auth = fakeAuthApi();
  auth.state.signedIn = SELF.address;
  const mail = fakeMailApi(fixtures);
  server.use(...auth.handlers, ...mail.handlers);
  return mail;
}

const pathOf = (router) => router.state.location.pathname;
const findList = (title) => screen.findByRole('list', { name: `Conversations in ${title}` });
const numbered = (count) => Array.from({ length: count }, (_, i) => makeThread({ subject: `Nachricht ${i + 1}` }));

function scrollToRow(list, row) {
  const scroller = list.parentElement;
  scroller.scrollTop = row * ROW_HEIGHT;
  fireEvent.scroll(scroller);
}

// Each rendered row shows the thread that belongs at its position.
function expectRowsInPlace(list) {
  const items = within(list).getAllByRole('listitem');
  for (const item of items) {
    expect(item).toHaveTextContent(new RegExp(`Nachricht ${item.getAttribute('aria-posinset')}(?!\\d)`));
  }
  return items;
}

describe('folders and labels', () => {
  it('opens the inbox from /, with the folder marked in the sidebar', async () => {
    serve({ threads: [makeThread({ subject: 'Mietvertrag' }), makeThread({ subject: 'Gesendet', folders: ['sent'] })] });
    const { router } = renderApp('/');

    const list = await findList('Inbox');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('Mietvertrag');
    expect(pathOf(router)).toBe('/inbox');
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Select a conversation to read it.')).toBeInTheDocument();
  });

  it('moves to another folder from the sidebar', async () => {
    serve({ threads: [makeThread({ subject: 'Mietvertrag' }), makeThread({ subject: 'Gesendet', folders: ['sent'] })] });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(screen.getByRole('link', { name: 'Sent' }));
    expect(await findList('Sent')).toHaveTextContent('Gesendet');
    expect(screen.queryByText('Mietvertrag')).not.toBeInTheDocument();
    expect(pathOf(router)).toBe('/sent');
  });

  it('lists labels with their unread counts and opens one', async () => {
    serve({
      labels: [UNI, WOHNUNG],
      threads: [makeThread({ subject: 'Prüfungsanmeldung', labelIds: [UNI.id] }), makeThread({ subject: 'Ohne Label' })],
    });
    const { router, user } = renderApp('/inbox');

    await user.click(await screen.findByRole('link', { name: 'Uni, 1 unread' }));
    const list = await findList('Uni');
    expect(list).toHaveTextContent('Prüfungsanmeldung');
    expect(list).not.toHaveTextContent('Ohne Label');
    expect(pathOf(router)).toBe('/label/label-uni');
    expect(screen.getByRole('link', { name: 'Wohnung' })).toBeInTheDocument();
  });

  it.each(['/bogus', '/label/label-gone'])('shows the 404 page for %s without asking for its mail', async (path) => {
    const mail = serve({ labels: [UNI] });
    renderApp(path);

    expect(await screen.findByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(mail.count('GET /api/threads')).toBe(0);
  });

  it('says when a folder is empty', async () => {
    serve({ threads: [makeThread()] });
    renderApp('/trash');
    expect(await screen.findByText('Nothing in Trash.')).toBeInTheDocument();
  });

  it('offers to try again when a folder cannot be loaded', async () => {
    const mail = serve({ threads: [makeThread({ subject: 'Mietvertrag' })] });
    mail.state.listStatus = 500;
    const { user } = renderApp('/inbox');

    expect(await screen.findByText(/Sift could not load Inbox\./)).toBeInTheDocument();
    mail.state.listStatus = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findList('Inbox')).toHaveTextContent('Mietvertrag');
  });
});

describe('the conversation list', () => {
  it('puts only the rows in view into the page', async () => {
    const mail = serve({ threads: numbered(300), pageSize: 100 });
    renderApp('/inbox');

    const list = await findList('Inbox');
    const items = expectRowsInPlace(list);
    // Ten rows fit, plus a few either side so fast scrolling shows no gaps.
    expect(items.length).toBeGreaterThanOrEqual(VIEWPORT_ROWS);
    expect(items.length).toBeLessThan(VIEWPORT_ROWS * 2);
    // The list is as tall as every loaded row, so the scrollbar is right.
    expect(list).toHaveStyle({ height: `${100 * ROW_HEIGHT}px` });
    expect(mail.cursors()).toEqual([null]);
  });

  it('loads older pages as the end comes near, keeps rows in order, and stops at the last page', async () => {
    const mail = serve({ threads: numbered(130), pageSize: 50 });
    renderApp('/inbox');
    const list = await findList('Inbox');

    scrollToRow(list, 20);
    // Nothing yet: the end of what is loaded is still well out of view.
    expect(mail.cursors()).toEqual([null]);

    scrollToRow(list, 36);
    await waitFor(() => expect(list).toHaveStyle({ height: `${100 * ROW_HEIGHT}px` }));
    expect(mail.cursors()).toEqual([null, '50']);

    scrollToRow(list, 90);
    await waitFor(() => expect(list).toHaveStyle({ height: `${130 * ROW_HEIGHT}px` }));

    scrollToRow(list, 120);
    await waitFor(() => expect(within(list).getByText('Nachricht 130')).toBeInTheDocument());
    const items = expectRowsInPlace(list);
    expect(items.at(-1)).toHaveAttribute('aria-setsize', '130');
    expect(mail.cursors()).toEqual([null, '50', '100']);
  });

  it('stops loading after a page fails, until asked to try again', async () => {
    const mail = serve({ threads: numbered(80), pageSize: 50 });
    mail.state.nextPageStatus = 500;
    const { user } = renderApp('/inbox');
    const list = await findList('Inbox');

    scrollToRow(list, 40);
    expect(await screen.findByText(/Sift could not load more conversations\./)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mail.cursors()).toEqual([null, '50']);

    mail.state.nextPageStatus = null;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(list).toHaveStyle({ height: `${80 * ROW_HEIGHT}px` }));
    expect(mail.cursors()).toEqual([null, '50', '50']);
  });
});

describe('reading a conversation', () => {
  it('opens a conversation from the list, oldest message first', async () => {
    const thread = makeThread({ subject: 'Mietvertrag', messageCount: 2 });
    serve({
      threads: [thread, makeThread({ subject: 'Anderes' })],
      messages: {
        [thread.id]: [
          makeMessage(thread, { bodyText: 'Hallo Semab,\nanbei der Vertrag.', sentAt: '2026-04-30T09:00:00.000Z' }),
          makeMessage(thread, { from: SELF, to: [MARA], bodyText: 'Danke, schaue ich mir an.', sentAt: '2026-04-30T10:00:00.000Z' }),
        ],
      },
    });
    const { router, user } = renderApp('/inbox');

    await user.click(await screen.findByRole('link', { name: /Mietvertrag/ }));
    const pane = await screen.findByRole('region', { name: 'Mietvertrag' });
    const [first, second] = within(pane).getAllByRole('article');

    expect(first).toHaveAccessibleName('From Mara Klein');
    expect(first).toHaveTextContent('to me');
    // Line breaks in the mail survive.
    expect(first.textContent).toContain('Hallo Semab,\nanbei der Vertrag.');
    expect(second).toHaveAccessibleName('From me');
    expect(second).toHaveTextContent('to Mara Klein');

    expect(pathOf(router)).toBe(`/inbox/${thread.id}`);
    expect(screen.getByRole('link', { name: /Mietvertrag/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: /Anderes/ })).not.toHaveAttribute('aria-current');
  });

  it('shows markup in a message as text, and never renders the HTML version', async () => {
    const thread = makeThread({ subject: 'Seltsame Mail' });
    serve({
      threads: [thread],
      messages: {
        [thread.id]: [
          makeMessage(thread, { bodyText: '<img src="x" onerror="window.__opened = true"><b>fett</b>' }),
          makeMessage(thread, { bodyText: '', bodyHtml: '<p>Nur HTML</p><script>window.__opened = true</script>' }),
        ],
      },
    });
    renderApp(`/inbox/${thread.id}`);

    const pane = await screen.findByRole('region', { name: 'Seltsame Mail' });
    expect(pane).toHaveTextContent('<img src="x" onerror="window.__opened = true"><b>fett</b>');
    expect(pane.querySelector('img, b, script')).toBeNull();
    expect(pane).toHaveTextContent('This message only has a formatted version, which Sift cannot show yet.');
    expect(pane).not.toHaveTextContent('Nur HTML');
    expect(window.__opened).toBeUndefined();
  });

  it('marks an unread conversation read when it opens, with one request', async () => {
    const unread = makeThread({ subject: 'Neue Nachricht', hasUnread: true, labelIds: [UNI.id] });
    const read = makeThread({ subject: 'Schon gelesen' });
    const mail = serve({
      labels: [UNI],
      threads: [unread, read],
      messages: { [unread.id]: [makeMessage(unread)], [read.id]: [makeMessage(read)] },
    });
    const { user } = renderApp('/inbox');

    await user.click(await screen.findByRole('link', { name: /^Unread, .*Neue Nachricht/ }));
    await screen.findByRole('region', { name: 'Neue Nachricht' });
    await waitFor(() => expect(screen.getByRole('link', { name: /Neue Nachricht/ })).not.toHaveAccessibleName(/^Unread/));
    expect(mail.state.batches).toEqual([{ ids: [unread.id], action: 'markRead' }]);
    // The row changed in place, and the label counts were asked for again.
    expect(mail.count('GET /api/threads')).toBe(1);
    await waitFor(() => expect(mail.count('GET /api/labels')).toBe(2));

    await user.click(screen.getByRole('link', { name: /Schon gelesen/ }));
    await screen.findByRole('region', { name: 'Schon gelesen' });
    expect(mail.state.batches).toHaveLength(1);
  });

  it('sends one request when the unread conversation is already in the cache', async () => {
    const unread = makeThread({ subject: 'Neue Nachricht', hasUnread: true });
    const mail = serve({ threads: [unread], messages: { [unread.id]: [makeMessage(unread)] } });
    const { queryClient, user } = renderApp('/inbox');
    // Cached before the pane mounts, so the effect has the marker on its very
    // first run, and strict mode runs that first run twice.
    queryClient.setQueryData(['thread', unread.id], { thread: unread, messages: [makeMessage(unread)] });

    await user.click(await screen.findByRole('link', { name: /Neue Nachricht/ }));
    await waitFor(() => expect(mail.state.batches).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mail.state.batches).toHaveLength(1);
  });

  it('explains when a conversation is not there', async () => {
    serve({ threads: [makeThread({ subject: 'Mietvertrag' })] });
    const { router, user } = renderApp('/inbox/thread-gone');

    expect(await screen.findByText('This conversation is not here. It may have been deleted.')).toBeInTheDocument();
    expect(await findList('Inbox')).toHaveTextContent('Mietvertrag');
    await user.click(screen.getByRole('link', { name: 'Back to the list' }));
    expect(pathOf(router)).toBe('/inbox');
    expect(await screen.findByText('Select a conversation to read it.')).toBeInTheDocument();
  });
});
