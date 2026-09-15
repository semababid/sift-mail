import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { findList, giveElementsASize, numbered, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';

giveElementsASize();

const pathOf = (router) => router.state.location.pathname;

describe('undoing an archive', () => {
  it('brings the conversation back and reopens it from the Undo button', async () => {
    const threads = numbered(3);
    const mail = serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[1].id}`);
    const list = await findList('Inbox');
    await screen.findByRole('region', { name: 'Nachricht 2' });

    await user.keyboard('e');
    await screen.findByText('Conversation archived.');
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Moved back to the inbox.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([
      { ids: [threads[1].id], action: 'archive' },
      { ids: [threads[1].id], action: 'moveToInbox' },
    ]);
    expect(pathOf(router)).toBe(`/inbox/${threads[1].id}`);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('z undoes a whole selection, and a second z sends nothing more', async () => {
    const threads = numbered(4);
    const mail = serve({ threads });
    const { router, user } = renderApp('/inbox');
    const list = await findList('Inbox');

    await user.click(screen.getByRole('checkbox', { name: 'Select Nachricht 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Nachricht 3' }));
    await user.keyboard('e');
    await screen.findByText('2 conversations archived.');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    // The undo is held up on its way, so the second z lands while it is still
    // unanswered, the moment a double press would really happen.
    mail.state.batchDelay = 100;
    await user.keyboard('zz');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(await screen.findByText('2 conversations moved back to the inbox.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([
      { ids: [threads[0].id, threads[2].id], action: 'archive' },
      { ids: [threads[0].id, threads[2].id], action: 'moveToInbox' },
    ]);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(4));
    // Nothing was open, so nothing reopens.
    expect(pathOf(router)).toBe('/inbox');
  });

  it('does nothing on z when there is nothing to undo', async () => {
    const mail = serve({ threads: numbered(2) });
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.keyboard('z');
    expect(mail.state.batches).toEqual([]);
  });

  it('offers Undo again when undoing fails', async () => {
    const threads = numbered(2);
    const mail = serve({ threads });
    const { user } = renderApp(`/inbox/${threads[0].id}`);
    await findList('Inbox');

    await user.keyboard('e');
    await screen.findByText('Conversation archived.');
    mail.state.batchStatus = 500;
    await user.keyboard('z');
    expect(await screen.findByText('Sift could not undo that.')).toBeInTheDocument();

    mail.state.batchStatus = null;
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Moved back to the inbox.')).toBeInTheDocument();
    expect(mail.state.batches.map((batch) => batch.action)).toEqual(['archive', 'moveToInbox', 'moveToInbox']);
  });
});
