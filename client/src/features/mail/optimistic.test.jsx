import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeMessage, makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, numbered, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';

giveElementsASize();

const pathOf = (router) => router.state.location.pathname;
const rowStar = (subject) => screen.getByRole('button', { name: `Star ${subject}` });
// The subjects of the rows on screen, top to bottom.
const subjectsIn = (list) =>
  within(list)
    .getAllByRole('link')
    .map((link) => link.getAttribute('aria-label').match(/Nachricht \d+/)[0]);

describe('starring', () => {
  it('s stars the open conversation before the server has answered', async () => {
    const threads = numbered(2);
    const mail = serve({ threads });
    mail.state.batchDelay = 300;
    const { user } = renderApp(`/inbox/${threads[0].id}`);
    await findList('Inbox');
    await screen.findByRole('region', { name: 'Nachricht 1' });

    await user.keyboard('s');
    await waitFor(() => expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Star conversation' })).toHaveAttribute('aria-pressed', 'true');
    expect(mail.state.batches).toEqual([{ ids: [threads[0].id], action: 'star' }]);
    expect(mail.state.answered).toEqual([]);

    await waitFor(() => expect(mail.state.answered).toEqual(['star']));
    expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'true');
    expect(rowStar('Nachricht 2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('takes the star off a starred row from its button', async () => {
    const threads = [makeThread({ subject: 'Wichtig', isStarred: true })];
    const mail = serve({ threads });
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(rowStar('Wichtig'));
    await waitFor(() => expect(rowStar('Wichtig')).toHaveAttribute('aria-pressed', 'false'));
    expect(mail.state.batches).toEqual([{ ids: [threads[0].id], action: 'unstar' }]);
  });

  it('stars a selection that is only partly starred, rather than unstarring it', async () => {
    const threads = [makeThread({ subject: 'Nachricht 1', isStarred: true }), makeThread({ subject: 'Nachricht 2' })];
    const mail = serve({ threads });
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(screen.getByRole('checkbox', { name: 'Select Nachricht 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Nachricht 2' }));
    await user.keyboard('s');

    await waitFor(() => expect(rowStar('Nachricht 2')).toHaveAttribute('aria-pressed', 'true'));
    expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'true');
    expect(mail.state.batches).toEqual([{ ids: [threads[0].id, threads[1].id], action: 'star' }]);
  });

  it('puts the star back as it was when the server refuses, and says so', async () => {
    const threads = numbered(1);
    const mail = serve({ threads });
    mail.state.failFor = new Set([threads[0].id]);
    mail.state.failDelay = 150;
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(rowStar('Nachricht 1'));
    await waitFor(() => expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByText('Sift could not star that.')).toBeInTheDocument();
    expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps a new star when a list reload that started before it lands afterwards', async () => {
    const threads = numbered(1);
    const mail = serve({ threads });
    const { queryClient, user } = renderApp('/inbox');
    await findList('Inbox');

    // A reload starts, and its answer, read before the star, is slow to arrive.
    mail.state.listDelay = 250;
    queryClient.invalidateQueries({ queryKey: ['threads'] });
    await waitFor(() => expect(mail.count('GET /api/threads')).toBe(2));

    await user.click(rowStar('Nachricht 1'));
    await waitFor(() => expect(mail.state.answered).toEqual(['star']));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'true');
  });

  it('rolls back only the conversation that failed, not a star added to another since', async () => {
    const threads = numbered(2);
    const mail = serve({ threads });
    // The first star is refused, and slowly, so the second has been starred
    // and confirmed by the time the first comes back.
    mail.state.failFor = new Set([threads[0].id]);
    mail.state.failDelay = 300;
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(rowStar('Nachricht 1'));
    await user.click(rowStar('Nachricht 2'));
    await waitFor(() => expect(mail.state.answered).toEqual(['star', 'star:failed']), { timeout: 1500 });

    await waitFor(() => expect(rowStar('Nachricht 1')).toHaveAttribute('aria-pressed', 'false'));
    expect(rowStar('Nachricht 2')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('archiving', () => {
  it('takes the conversation out of the list before the server has answered', async () => {
    const threads = numbered(3);
    const mail = serve({ threads });
    mail.state.batchDelay = 300;
    const { router, user } = renderApp(`/inbox/${threads[0].id}`);
    const list = await findList('Inbox');

    await user.keyboard('e');
    expect(pathOf(router)).toBe(`/inbox/${threads[1].id}`);
    await waitFor(() => expect(subjectsIn(list)).toEqual(['Nachricht 2', 'Nachricht 3']));
    expect(mail.state.answered).toEqual([]);
  });

  it('puts a refused archive back in its place and reopens it', async () => {
    const threads = numbered(3);
    const mail = serve({ threads });
    mail.state.failFor = new Set([threads[1].id]);
    mail.state.failDelay = 150;
    const { router, user } = renderApp(`/inbox/${threads[1].id}`);
    const list = await findList('Inbox');
    await screen.findByRole('region', { name: 'Nachricht 2' });

    await user.keyboard('e');
    await waitFor(() => expect(subjectsIn(list)).toEqual(['Nachricht 1', 'Nachricht 3']));

    expect(await screen.findByText('Sift could not archive that, so it is back where it was.')).toBeInTheDocument();
    expect(subjectsIn(list)).toEqual(['Nachricht 1', 'Nachricht 2', 'Nachricht 3']);
    expect(pathOf(router)).toBe(`/inbox/${threads[1].id}`);
  });

  it('leaves the user where they went when an archive is refused after they moved on', async () => {
    const threads = numbered(4);
    const mail = serve({ threads });
    mail.state.failFor = new Set([threads[0].id]);
    mail.state.failDelay = 250;
    const { router, user } = renderApp(`/inbox/${threads[0].id}`);
    const list = await findList('Inbox');

    await user.keyboard('e');
    expect(pathOf(router)).toBe(`/inbox/${threads[1].id}`);
    await user.keyboard('j');
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);

    expect(await screen.findByText('Sift could not archive that, so it is back where it was.')).toBeInTheDocument();
    expect(pathOf(router)).toBe(`/inbox/${threads[2].id}`);
    expect(subjectsIn(list)).toEqual(['Nachricht 1', 'Nachricht 2', 'Nachricht 3', 'Nachricht 4']);
  });

  it('Undo brings the rows back before the server has answered it', async () => {
    const threads = numbered(3);
    const mail = serve({ threads });
    const { user } = renderApp(`/inbox/${threads[0].id}`);
    const list = await findList('Inbox');

    await user.keyboard('e');
    await waitFor(() => expect(mail.state.answered).toEqual(['archive']));
    await waitFor(() => expect(subjectsIn(list)).toEqual(['Nachricht 2', 'Nachricht 3']));

    mail.state.batchDelay = 300;
    await user.keyboard('z');
    await waitFor(() => expect(subjectsIn(list)).toEqual(['Nachricht 1', 'Nachricht 2', 'Nachricht 3']));
    expect(mail.state.answered).toEqual(['archive']);
  });

  it('does not send Undo until the archive has reached the server', async () => {
    const threads = numbered(2);
    const mail = serve({ threads });
    mail.state.batchDelay = 150;
    const { user } = renderApp(`/inbox/${threads[0].id}`);
    await findList('Inbox');

    await user.keyboard('ez');
    expect(mail.state.batches.map((batch) => batch.action)).toEqual(['archive']);

    await waitFor(() => expect(mail.state.answered).toEqual(['archive', 'moveToInbox']), { timeout: 1500 });
    expect(await screen.findByText('Moved back to the inbox.')).toBeInTheDocument();
  });
});

describe('marking read', () => {
  it('shows a conversation as read at once, and unread again if the server refuses', async () => {
    const unread = makeThread({ subject: 'Neu', hasUnread: true });
    const mail = serve({ threads: [unread], messages: { [unread.id]: [makeMessage(unread)] } });
    mail.state.failFor = new Set([unread.id]);
    mail.state.failDelay = 250;
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(screen.getByRole('link', { name: /Neu/ }));
    await waitFor(() => expect(screen.getByRole('link', { name: /Neu/ })).not.toHaveAccessibleName(/^Unread/));
    expect(mail.state.answered).toEqual([]);

    await waitFor(() => expect(screen.getByRole('link', { name: /Neu/ })).toHaveAccessibleName(/^Unread/));
    // Refused once, it is not sent again in a loop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mail.state.batches).toHaveLength(1);
  });
});

describe('loading and empty states', () => {
  it('shows placeholder rows while a folder loads', async () => {
    const mail = serve({ threads: numbered(2) });
    mail.state.listDelay = 200;
    renderApp('/inbox');

    const loading = (await screen.findByText('Loading conversations')).closest('[role="status"]');
    expect(loading.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);

    await findList('Inbox');
    expect(screen.queryByText('Loading conversations')).not.toBeInTheDocument();
  });

  it.each([
    ['inbox', 'Your inbox is empty.', 'Press c to write a message.'],
    ['sent', 'Nothing sent yet.', null],
    ['drafts', 'No drafts.', 'A message you close before sending is kept here.'],
    ['archive', 'Nothing archived yet.', 'Press e on a conversation in the inbox to archive it.'],
    ['spam', 'No spam.', null],
    ['trash', 'Trash is empty.', null],
  ])('says what an empty %s means', async (folder, text, hint) => {
    serve({ threads: [] });
    renderApp(`/${folder}`);

    expect(await screen.findByText(text)).toBeInTheDocument();
    if (hint) expect(screen.getByText(hint)).toBeInTheDocument();
  });
});
