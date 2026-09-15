import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, numbered, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';

giveElementsASize();

const UNI = { id: 'label-uni', name: 'Uni', color: '#0ea5e9', threadCount: 0, unreadCount: 0 };
const WOHNUNG = { id: 'label-wohnung', name: 'Wohnung', color: '#16a34a', threadCount: 0, unreadCount: 0 };

const pathOf = (router) => router.state.location.pathname;
const addressOf = (router) => `${router.state.location.pathname}${router.state.location.search}`;
const searchBox = () => screen.getByRole('searchbox', { name: 'Search mail' });

describe('moving with j and k', () => {
  it('j opens the first conversation and then each next one, and k goes back', async () => {
    const threads = numbered(3);
    serve({ threads });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('j');
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);
    await user.keyboard('jj');
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);
    // The last conversation stays open rather than wrapping round.
    await user.keyboard('j');
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);

    await user.keyboard('k');
    expect(pathOf(router)).toBe(`/inbox/${threads[1].id}`);
    expect(await screen.findByRole('region', { name: 'Nachricht 2' })).toBeInTheDocument();
  });

  it('scrolls the list to a conversation opened far down', async () => {
    const threads = numbered(60);
    serve({ threads });
    renderApp(`/inbox/${threads[40].id}`);

    // Only about sixteen rows are in the page at a time, so this row exists
    // only if the list scrolled to it.
    expect(await screen.findByRole('link', { name: /Nachricht 41,/ })).toHaveAttribute('aria-current', 'true');
  });

  it('leaves the keys alone while typing in the search box', async () => {
    const mail = serve({ threads: numbered(2) });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(searchBox());
    await user.keyboard('jex');
    expect(searchBox()).toHaveValue('jex');
    expect(pathOf(router)).toBe('/inbox');
    expect(mail.state.batches).toEqual([]);
  });

  it('leaves keys pressed with Control or Alt to the browser', async () => {
    serve({ threads: numbered(2) });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('{Control>}j{/Control}{Alt>}j{/Alt}');
    expect(pathOf(router)).toBe('/inbox');
  });
});

describe('selecting and archiving', () => {
  it('e archives the open conversation and opens the next one', async () => {
    const threads = [makeThread({ subject: 'Erste' }), makeThread({ subject: 'Zweite' }), makeThread({ subject: 'Dritte' })];
    const mail = serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[1].id}`);
    const list = await findList('Inbox');
    await screen.findByRole('region', { name: 'Zweite' });

    await user.keyboard('e');
    expect(await screen.findByText('Conversation archived.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[1].id], action: 'archive' }]);
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);
    expect(list).not.toHaveTextContent('Zweite');
    // Taken out of the cached inbox, not loaded again.
    expect(mail.count('GET /api/threads')).toBe(1);
  });

  it('x selects conversations, and e archives the whole selection', async () => {
    const threads = numbered(4);
    const mail = serve({ threads });
    const { router, user } = renderApp('/inbox');
    const list = await findList('Inbox');

    await user.keyboard('jx');
    await user.keyboard('jjx');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Nachricht 1' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Nachricht 2' })).not.toBeChecked();

    await user.keyboard('e');
    expect(await screen.findByText('2 conversations archived.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[0].id, threads[2].id], action: 'archive' }]);
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    // The open conversation went with the selection, so the next one down opens.
    expect(pathOf(router)).toBe(`/inbox/${threads[3].id}`);
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('skips the rest of the selection when choosing what opens next', async () => {
    const threads = numbered(4);
    const mail = serve({ threads });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    // Nachricht 1 and 2 selected, with 1 open. The row below the open one is
    // being archived too, so it cannot be the one that opens next.
    await user.keyboard('jxjxk');
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);

    await user.keyboard('e');
    expect(await screen.findByText('2 conversations archived.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[0].id, threads[1].id], action: 'archive' }]);
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);
  });

  it('Escape clears the selection first, then closes the conversation', async () => {
    const threads = numbered(2);
    serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[0].id}`);

    await user.click(await screen.findByRole('checkbox', { name: 'Select Nachricht 2' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);

    await user.keyboard('{Escape}');
    expect(pathOf(router)).toBe('/inbox');
  });

  it('starts every folder with nothing selected, including the one it came back to', async () => {
    const threads = [makeThread({ subject: 'Posteingang' }), makeThread({ subject: 'Gesendet', folders: ['sent'] })];
    serve({ threads });
    const { user } = renderApp('/inbox');

    await user.click(await screen.findByRole('checkbox', { name: 'Select Posteingang' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Sent' }));
    await findList('Sent');
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Inbox' }));
    await findList('Inbox');
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Posteingang' })).not.toBeChecked();
  });

  it('will not archive outside the inbox, and says why', async () => {
    const sent = makeThread({ subject: 'Gesendet', folders: ['sent'] });
    const mail = serve({ threads: [sent] });
    const { user } = renderApp(`/sent/${sent.id}`);
    await findList('Sent');

    await user.keyboard('e');
    expect(await screen.findByText('Only conversations in the inbox can be archived.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([]);
  });

  it('says so when archiving fails, and keeps the conversation where it was', async () => {
    const threads = numbered(2);
    const mail = serve({ threads });
    mail.state.batchStatus = 500;
    const { router, user } = renderApp(`/inbox/${threads[0].id}`);
    const list = await findList('Inbox');

    await user.keyboard('e');
    expect(await screen.findByText('Sift could not archive that. Try again.')).toBeInTheDocument();
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('the command palette', () => {
  it('opens with Ctrl+K, filters as you type, and runs the chosen command', async () => {
    serve({ threads: numbered(1), labels: [UNI, WOHNUNG] });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox', { name: 'Command' })).toHaveFocus();

    await user.keyboard('sent go');
    const options = within(screen.getByRole('listbox', { name: 'Commands' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Go to Sent']);

    await user.keyboard('{Enter}');
    expect(pathOf(router)).toBe('/sent');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves through the matches with the arrow keys', async () => {
    serve({ threads: numbered(1), labels: [UNI, WOHNUNG] });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('{Control>}k{/Control}label');
    const input = screen.getByRole('combobox', { name: 'Command' });
    const [uni, wohnung] = screen.getAllByRole('option');
    expect(uni).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(wohnung).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', wohnung.id);
    await user.keyboard('{ArrowDown}');
    expect(uni).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(pathOf(router)).toBe('/label/label-wohnung');
  });

  it('closes on Escape and gives focus back to what had it', async () => {
    serve({ threads: numbered(1) });
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    const button = screen.getByRole('button', { name: 'Open command palette' });
    await user.click(button);
    expect(screen.getByRole('combobox', { name: 'Command' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('leaves the cursor in the search box after running Search mail', async () => {
    serve({ threads: numbered(1) });
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    // Opened from the button, so closing the palette hands focus back to the
    // button. The search box has to take focus after that, not before it.
    await user.click(screen.getByRole('button', { name: 'Open command palette' }));
    await user.keyboard('search mail{Enter}');
    await waitFor(() => expect(searchBox()).toHaveFocus());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(searchBox()).toHaveFocus();
  });
});

describe('the shortcut sheet', () => {
  it('opens with ?, and keys do nothing behind it until it closes', async () => {
    const threads = numbered(2);
    serve({ threads });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveTextContent('Open the next conversation');
    await user.keyboard('j');
    expect(pathOf(router)).toBe('/inbox');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('j');
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);
  });
});

describe('searching', () => {
  it('/ puts the cursor in the search box, and Enter lists the matches', async () => {
    const threads = [
      makeThread({ subject: 'Mietvertrag Wohnung' }),
      makeThread({ subject: 'Stromrechnung' }),
      makeThread({ subject: 'Alter Mietvertrag', folders: ['archive'] }),
      makeThread({ subject: 'Mietvertrag Gewinn', folders: ['spam'] }),
    ];
    serve({ threads });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('/');
    expect(searchBox()).toHaveFocus();
    // The slash opened the box without being typed into it.
    expect(searchBox()).toHaveValue('');

    await user.keyboard('mietvertrag{Enter}');
    const list = await findList('Search results');
    expect(addressOf(router)).toBe('/search?q=mietvertrag');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list).toHaveTextContent('Match: Snippet');
    expect(searchBox()).toHaveValue('mietvertrag');
    expect(searchBox()).not.toHaveFocus();

    // The keys work on the results straight away, and keep the search.
    await user.keyboard('j');
    expect(addressOf(router)).toBe(`/search/${threads[0].id}?q=mietvertrag`);
  });

  it('says when nothing matches', async () => {
    serve({ threads: numbered(2) });
    renderApp('/search?q=kuendigung');
    expect(await screen.findByText('No conversations match "kuendigung".')).toBeInTheDocument();
  });

  it('gives the keys back when Escape leaves the search box', async () => {
    const threads = numbered(2);
    serve({ threads });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('/abc{Escape}');
    expect(searchBox()).not.toHaveFocus();
    await user.keyboard('j');
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);
  });
});
