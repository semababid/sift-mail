import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, numbered, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';

giveElementsASize();

const UNI = { id: 'label-uni', name: 'Uni', color: '#0ea5e9', threadCount: 0, unreadCount: 0 };

const pathOf = (router) => router.state.location.pathname;
const searchBox = () => screen.getByRole('searchbox', { name: 'Search mail' });

// jsdom has no matchMedia, which the mailbox reads as a wide screen. This makes
// every media query fail, as it would on a phone.
function pretendNarrowScreen() {
  window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
}

afterEach(() => {
  delete window.matchMedia;
});

describe('searching from an open conversation', () => {
  it('closes the conversation on a narrow screen, so the search box can take the cursor', async () => {
    pretendNarrowScreen();
    const threads = numbered(2);
    serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[0].id}`);
    await findList('Inbox');

    await user.keyboard('/');
    expect(pathOf(router)).toBe('/inbox');
    await waitFor(() => expect(searchBox()).toHaveFocus());
  });

  it('keeps the conversation open on a wide screen', async () => {
    const threads = numbered(2);
    serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[0].id}`);
    await findList('Inbox');

    await user.keyboard('/');
    expect(searchBox()).toHaveFocus();
    expect(pathOf(router)).toBe(`/inbox/${threads[0].id}`);
  });
});

describe('the menu', () => {
  it('shows folders, labels and sign-out, and closes once a folder is picked', async () => {
    serve({ threads: [makeThread({ subject: 'Posteingang' }), makeThread({ subject: 'Gesendet', folders: ['sent'] })], labels: [UNI] });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    expect(within(menu).getByRole('link', { name: 'Inbox' })).toHaveFocus();
    expect(await within(menu).findByRole('link', { name: 'Uni' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('link', { name: 'Sent' }));
    expect(pathOf(router)).toBe('/sent');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await findList('Sent')).toHaveTextContent('Gesendet');
  });

  it('keeps Tab inside, ignores shortcuts, closes on Escape and hands focus back', async () => {
    serve({ threads: numbered(1) });
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    const button = screen.getByRole('button', { name: 'Open menu' });
    await user.click(button);
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    const inbox = within(menu).getByRole('link', { name: 'Inbox' });
    const signOut = within(menu).getByRole('button', { name: 'Sign out' });

    await user.tab({ shift: true });
    expect(signOut).toHaveFocus();
    await user.tab();
    expect(inbox).toHaveFocus();

    await user.keyboard('j');
    expect(pathOf(router)).toBe('/inbox');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});
