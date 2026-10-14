import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';

giveElementsASize();

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const scoresButton = () => screen.getByRole('button', { name: 'Scores' });
const row = (subject) => screen.getByRole('link', { name: new RegExp(`, ${subject},`) });

function serveTwoMatches() {
  return serve({
    threads: [makeThread({ subject: 'Kaution zurück' }), makeThread({ subject: 'Kaution Nachzahlung' }), makeThread({ subject: 'Seminar' })],
  });
}

describe('search results', () => {
  it('show no scores at first, and do not ask for them', async () => {
    const mail = serveTwoMatches();
    renderApp('/search?q=kaution');
    const list = await findList('Search results');

    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(scoresButton()).toHaveAttribute('aria-pressed', 'false');
    expect(list).not.toHaveTextContent('rrf');
    // Both searches ran, so there is nothing to say about how.
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(mail.searches()).toEqual([{ q: 'kaution' }]);
  });

  it("show each result's merged score and both ranks once scores are on", async () => {
    const mail = serveTwoMatches();
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');

    await user.click(scoresButton());
    expect(scoresButton()).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(row('Kaution zurück')).toHaveTextContent('meaning no match'));

    // The first was found by keyword alone, the second by both.
    expect(row('Kaution zurück')).toHaveTextContent('rrf 0.0164keyword #1 (3.00)meaning no match');
    expect(row('Kaution Nachzahlung')).toHaveTextContent('rrf 0.0161keyword #2 (2.50)meaning #1 (0.890)');
    expect(row('Kaution Nachzahlung')).toHaveAccessibleName(/score 0\.0161, keyword rank 2, meaning rank 1$/);
    expect(screen.getByRole('note')).toHaveTextContent('merged by rank (RRF, k = 60)');
    expect(mail.searches().at(-1)).toEqual({ q: 'kaution', debug: 'true' });
    // Rows are taller with the score line, and the list lays them out that way.
    expect(row('Kaution Nachzahlung').closest('li')).toHaveStyle({ height: '104px' });
  });

  it('keep the results on screen while the scores load', async () => {
    const mail = serveTwoMatches();
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');
    mail.state.searchDelay = 50;

    await user.click(scoresButton());
    expect(screen.queryByText('Loading conversations')).not.toBeInTheDocument();
    expect(row('Kaution zurück')).toHaveTextContent('rrf 0.0164');
  });

  it('remember that scores are on after a reload, and forget it once they are off', async () => {
    serveTwoMatches();
    const first = renderApp('/search?q=kaution');
    await findList('Search results');
    await first.user.click(scoresButton());
    first.unmount();

    const second = renderApp('/search?q=kaution');
    await findList('Search results');
    expect(scoresButton()).toHaveAttribute('aria-pressed', 'true');
    await second.user.click(scoresButton());
    second.unmount();

    renderApp('/search?q=kaution');
    await findList('Search results');
    expect(scoresButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('still turn scores on and off when the browser will not store the setting', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    // A click whose handler throws still shows its change on screen, so the
    // error itself is what to look for.
    const errors = [];
    const onError = (event) => errors.push(event.error ?? event.message);
    window.addEventListener('error', onError);
    serveTwoMatches();
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');

    await user.click(scoresButton());
    expect(scoresButton()).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findAllByText(/^rrf /)).toHaveLength(2);
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
  });

  it('can turn scores on from the command palette', async () => {
    serveTwoMatches();
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('show search scores{Enter}');
    await waitFor(() => expect(scoresButton()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('keep their snippet and scores when a result is starred', async () => {
    serveTwoMatches();
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');
    await user.click(scoresButton());
    await waitFor(() => expect(row('Kaution zurück')).toHaveTextContent('meaning no match'));

    await user.click(screen.getByRole('button', { name: 'Star Kaution zurück' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Star Kaution zurück' })).toHaveAttribute('aria-pressed', 'true'));
    expect(row('Kaution zurück')).toHaveTextContent('Match: Snippet');
    expect(row('Kaution zurück')).toHaveTextContent('keyword #1 (3.00)');
  });

  it('put a refused star back, scores and all', async () => {
    const mail = serveTwoMatches();
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');
    await user.click(scoresButton());
    await waitFor(() => expect(row('Kaution zurück')).toHaveTextContent('meaning no match'));
    mail.state.batchStatus = 500;

    await user.click(screen.getByRole('button', { name: 'Star Kaution zurück' }));
    expect(await screen.findByText('Sift could not star that.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Star Kaution zurück' })).toHaveAttribute('aria-pressed', 'false');
    expect(row('Kaution zurück')).toHaveTextContent('keyword #1 (3.00)');
  });
});

describe('when search by meaning is down', () => {
  it('says the results are keyword matches only, scores or not', async () => {
    const mail = serveTwoMatches();
    mail.state.searchMode = 'keyword';
    const { user } = renderApp('/search?q=kaution');
    await findList('Search results');
    expect(screen.getByRole('note')).toHaveTextContent('Keyword matches only. Search by meaning is unavailable right now.');

    await user.click(scoresButton());
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent('unavailable right now: the model is not running.'));
    expect(row('Kaution Nachzahlung')).toHaveTextContent('meaning no match');
  });
});

describe('outside search', () => {
  it('there is no scores button and no score command', async () => {
    serve({ threads: [makeThread({ subject: 'Kaution zurück' })] });
    const { user } = renderApp('/inbox');
    await findList('Inbox');
    expect(screen.queryByRole('button', { name: 'Scores' })).not.toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('scores');
    expect(screen.queryByRole('option', { name: /search scores/ })).not.toBeInTheDocument();
  });
});
