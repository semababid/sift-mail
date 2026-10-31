import { describe, expect, it } from 'vitest';
import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { makeMessage, makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';
import { DRAG_TYPE } from './buckets.jsx';

giveElementsASize();

const addressOf = (router) => `${router.state.location.pathname}${router.state.location.search}`;
const tabs = () => screen.getByRole('navigation', { name: 'Buckets' });
const tab = (name) => within(tabs()).getByRole('link', { name: new RegExp(`^${name}`) });
const rows = (list) => within(list).getAllByRole('listitem');

// Five conversations, sorted by the model unless said otherwise.
function mailbox() {
  const threads = [
    makeThread({ subject: 'Kino morgen?', bucket: 'needs_reply', bucketSource: 'model' }),
    makeThread({ subject: 'Ihre Bewerbung', bucket: 'waiting_on_them', bucketSource: 'model' }),
    makeThread({ subject: 'Termin Bürgeramt', bucket: 'do_at_a_time', bucketSource: 'user', modelBucket: 'read_only' }),
    makeThread({ subject: 'Newsletter', bucket: 'read_only', bucketSource: 'model' }),
    makeThread({ subject: 'Noch nicht sortiert' }),
  ];
  return { threads, mail: serve({ threads }) };
}

// A drag carrying what a row puts on it, as the browser would hand it on.
function dataTransfer() {
  const data = new Map();
  return {
    types: [],
    setData(type, value) {
      data.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData: (type) => data.get(type) ?? '',
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}
function drag(from, to, transfer = dataTransfer()) {
  fireEvent.dragStart(from, { dataTransfer: transfer });
  const over = createEvent.dragOver(to, { dataTransfer: transfer });
  fireEvent(to, over);
  fireEvent.drop(to, { dataTransfer: transfer });
  return over;
}

describe('the bucket tabs', () => {
  it('show every bucket with how many conversations it holds, and a label on each row', async () => {
    mailbox();
    renderApp('/inbox');
    const list = await findList('Inbox');

    await waitFor(() => expect(tab('Needs reply')).toHaveTextContent('Needs reply1'));
    // Read only is the bulk of a mailbox, so it goes uncounted.
    expect(tabs()).toHaveTextContent(/^AllNeeds reply1Waiting1To do1Read only$/);
    expect(tab('All')).toHaveAttribute('aria-current', 'page');
    expect(rows(list)).toHaveLength(5);
    expect(within(list).getByRole('link', { name: /Kino morgen\?, Needs reply,/ })).toBeInTheDocument();
    // Not sorted yet: no label.
    expect(within(list).getByRole('link', { name: /Noch nicht sortiert, \d/ })).toBeInTheDocument();
  });

  it('list one bucket at a time, from its own address', async () => {
    mailbox();
    const { router, user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(tab('Needs reply'));
    const list = await findList('Needs reply');
    expect(addressOf(router)).toBe('/inbox?bucket=needs_reply');
    expect(rows(list)).toHaveLength(1);
    expect(tab('Needs reply')).toHaveAttribute('aria-current', 'page');
    // Every row is in this bucket, so none needs the label.
    expect(within(list).getByRole('link', { name: /Kino morgen\?, \d/ })).toBeInTheDocument();
  });

  it('keep the bucket in the address of a conversation opened from it', async () => {
    const { threads } = mailbox();
    const { router, user } = renderApp('/inbox?bucket=needs_reply');
    await findList('Needs reply');
    await user.keyboard('j');
    expect(addressOf(router)).toBe(`/inbox/${threads[0].id}?bucket=needs_reply`);
  });

  it('say so when a bucket is empty', async () => {
    serve({ threads: [makeThread({ bucket: 'read_only', bucketSource: 'model' })] });
    renderApp('/inbox?bucket=needs_reply');
    expect(await screen.findByText('Nothing is waiting for a reply from you.')).toBeInTheDocument();
  });

  it('show the whole inbox for a bucket that does not exist', async () => {
    mailbox();
    renderApp('/inbox?bucket=urgent');
    expect(rows(await findList('Inbox'))).toHaveLength(5);
  });

  it('are only in the inbox', async () => {
    serve({ threads: [makeThread({ folders: ['archive'], bucket: 'read_only', bucketSource: 'model' })] });
    renderApp('/archive');
    await findList('Archive');
    expect(screen.queryByRole('navigation', { name: 'Buckets' })).not.toBeInTheDocument();
  });
});

describe('moving a conversation with a key', () => {
  it('puts the open conversation in the bucket its number names', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp(`/inbox/${threads[3].id}`);
    const list = await findList('Inbox');

    await user.keyboard('1');
    expect(await screen.findByText('Moved to Needs reply.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[3].id], action: 'setBucket', bucket: 'needs_reply' }]);
    expect(within(list).getByRole('link', { name: /Newsletter, Needs reply,/ })).toBeInTheDocument();
    await waitFor(() => expect(tab('Needs reply')).toHaveTextContent('Needs reply2'));
  });

  it('shows the move at once, before the server has answered', async () => {
    const { threads, mail } = mailbox();
    mail.state.batchDelay = 300;
    const { user } = renderApp(`/inbox/${threads[3].id}`);
    const list = await findList('Inbox');

    await user.keyboard('2');
    expect(within(list).getByRole('link', { name: /Newsletter, Waiting,/ })).toBeInTheDocument();
    expect(mail.state.answered).toEqual([]);
  });

  it('moves a whole selection', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    await user.click(screen.getByRole('checkbox', { name: 'Select Kino morgen?' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Newsletter' }));
    await user.keyboard('3');
    expect(await screen.findByText('2 conversations moved to To do.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[0].id, threads[3].id], action: 'setBucket', bucket: 'do_at_a_time' }]);
    // The selection is done with.
    expect(screen.getByRole('checkbox', { name: 'Select Kino morgen?' })).not.toBeChecked();
  });

  it('says what to do when nothing is open or selected', async () => {
    const { mail } = mailbox();
    const { user } = renderApp('/inbox');
    await findList('Inbox');
    await user.keyboard('2');
    expect(await screen.findByText('Open or select a conversation to move it.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([]);
  });

  it('takes the conversation out of a bucket tab it no longer belongs in, and opens the next', async () => {
    const threads = [
      makeThread({ subject: 'Erste', bucket: 'needs_reply', bucketSource: 'model' }),
      makeThread({ subject: 'Zweite', bucket: 'needs_reply', bucketSource: 'model' }),
    ];
    serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[0].id}?bucket=needs_reply`);
    const list = await findList('Needs reply');

    await user.keyboard('4');
    await screen.findByText('Moved to Read only.');
    await waitFor(() => expect(rows(list)).toHaveLength(1));
    expect(addressOf(router)).toBe(`/inbox/${threads[1].id}?bucket=needs_reply`);
  });

  it('stays in a bucket tab when moved to that same bucket', async () => {
    const { threads, mail } = mailbox();
    const { router, user } = renderApp(`/inbox/${threads[0].id}?bucket=needs_reply`);
    const list = await findList('Needs reply');
    await user.keyboard('1');
    await screen.findByText('Moved to Needs reply.');
    await waitFor(() => expect(mail.state.answered).toEqual(['setBucket']));
    expect(rows(list)).toHaveLength(1);
    expect(addressOf(router)).toBe(`/inbox/${threads[0].id}?bucket=needs_reply`);
  });
});

describe('undoing a move', () => {
  it('gives the model’s bucket back, and reopens the conversation', async () => {
    const threads = [
      makeThread({ subject: 'Erste', bucket: 'needs_reply', bucketSource: 'model' }),
      makeThread({ subject: 'Zweite', bucket: 'needs_reply', bucketSource: 'model' }),
    ];
    const mail = serve({ threads });
    const { router, user } = renderApp(`/inbox/${threads[0].id}?bucket=needs_reply`);
    const list = await findList('Needs reply');

    await user.keyboard('4');
    await screen.findByText('Moved to Read only.');
    await user.keyboard('z');
    expect(await screen.findByText('Moved back.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([
      { ids: [threads[0].id], action: 'setBucket', bucket: 'read_only' },
      { ids: [threads[0].id], action: 'resetBucket' },
    ]);
    await waitFor(() => expect(rows(list)).toHaveLength(2));
    expect(addressOf(router)).toBe(`/inbox/${threads[0].id}?bucket=needs_reply`);
  });

  it('puts back a bucket the user had chosen, as their choice', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp(`/inbox/${threads[2].id}`);
    await findList('Inbox');

    await user.keyboard('1');
    await screen.findByText('Moved to Needs reply.');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('Moved back.');
    expect(mail.state.batches.at(-1)).toEqual({ ids: [threads[2].id], action: 'setBucket', bucket: 'do_at_a_time' });
  });

  it('puts back a selection that came from different places, each the way it was', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp('/inbox');
    await findList('Inbox');

    for (const subject of ['Kino morgen?', 'Termin Bürgeramt', 'Noch nicht sortiert']) {
      await user.click(screen.getByRole('checkbox', { name: `Select ${subject}` }));
    }
    await user.keyboard('4');
    await screen.findByText('3 conversations moved to Read only.');
    await user.keyboard('z');
    await screen.findByText('3 conversations moved back.');
    expect(mail.state.batches.slice(1)).toEqual([
      { ids: [threads[0].id, threads[4].id], action: 'resetBucket' },
      { ids: [threads[2].id], action: 'setBucket', bucket: 'do_at_a_time' },
    ]);
    const list = await findList('Inbox');
    await waitFor(() => expect(within(list).getByRole('link', { name: /Termin Bürgeramt, To do,/ })).toBeInTheDocument());
  });
});

describe('moving by dragging', () => {
  it('moves a row dropped on a bucket tab', async () => {
    const { threads, mail } = mailbox();
    renderApp('/inbox');
    const list = await findList('Inbox');

    const over = drag(within(list).getByRole('link', { name: /, Newsletter,/ }), tab('Waiting'));
    // Accepting the drop is what lets the browser allow it.
    expect(over.defaultPrevented).toBe(true);
    expect(await screen.findByText('Moved to Waiting.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[3].id], action: 'setBucket', bucket: 'waiting_on_them' }]);
  });

  it('carries the whole selection when the drag starts on a selected row', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp('/inbox');
    const list = await findList('Inbox');
    await user.click(screen.getByRole('checkbox', { name: 'Select Kino morgen?' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Newsletter' }));

    drag(within(list).getByRole('link', { name: /, Newsletter,/ }), tab('To do'));
    await screen.findByText('2 conversations moved to To do.');
    expect(mail.state.batches[0].ids).toEqual([threads[0].id, threads[3].id]);
  });

  it('carries only its own row when that row is not selected', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp('/inbox');
    const list = await findList('Inbox');
    await user.click(screen.getByRole('checkbox', { name: 'Select Kino morgen?' }));

    drag(within(list).getByRole('link', { name: /, Newsletter,/ }), tab('To do'));
    await screen.findByText('Moved to To do.');
    expect(mail.state.batches[0].ids).toEqual([threads[3].id]);
  });

  it('ignores anything dropped that is not a conversation, such as a file, and the All tab', async () => {
    const { mail } = mailbox();
    renderApp('/inbox');
    const list = await findList('Inbox');

    const file = dataTransfer();
    file.setData('Files', 'notes.txt');
    const over = createEvent.dragOver(tab('Waiting'), { dataTransfer: file });
    fireEvent(tab('Waiting'), over);
    fireEvent.drop(tab('Waiting'), { dataTransfer: file });
    expect(over.defaultPrevented).toBe(false);

    const onAll = drag(within(list).getByRole('link', { name: /, Newsletter,/ }), tab('All'));
    expect(onAll.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mail.state.batches).toEqual([]);
  });
});

describe('when the move is refused', () => {
  it('puts the row back and says so', async () => {
    const { threads, mail } = mailbox();
    mail.state.failFor.add(threads[0].id);
    const { user } = renderApp(`/inbox/${threads[0].id}`);
    const list = await findList('Inbox');

    await user.keyboard('4');
    expect(await screen.findByText('Sift could not move that, so it is back where it was.')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /Kino morgen\?, Needs reply,/ })).toBeInTheDocument();
  });
});

describe('from the command palette', () => {
  it('moves the open conversation, and opens a bucket tab', async () => {
    const { threads, mail } = mailbox();
    const { router, user } = renderApp(`/inbox/${threads[3].id}`);
    await findList('Inbox');

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('move to to do{Enter}');
    await screen.findByText('Moved to To do.');
    expect(mail.state.batches).toEqual([{ ids: [threads[3].id], action: 'setBucket', bucket: 'do_at_a_time' }]);

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('show waiting{Enter}');
    await waitFor(() => expect(addressOf(router)).toBe('/inbox?bucket=waiting_on_them'));
  });
});

describe('letting Sift choose again', () => {
  it('takes the user’s choice away once the undo has gone', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp(`/inbox/${threads[2].id}`);
    const list = await findList('Inbox');

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('let sift choose{Enter}');
    expect(await screen.findByText('Sift chooses the bucket again.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([{ ids: [threads[2].id], action: 'resetBucket' }]);
    expect(within(list).getByRole('link', { name: /Termin Bürgeramt, Read only,/ })).toBeInTheDocument();
  });

  it('says so when Sift already chooses', async () => {
    const { threads, mail } = mailbox();
    const { user } = renderApp(`/inbox/${threads[0].id}`);
    await findList('Inbox');

    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('let sift choose{Enter}');
    expect(await screen.findByText('Sift already chooses the bucket for that.')).toBeInTheDocument();
    expect(mail.state.batches).toEqual([]);
  });
});

describe('why a conversation is in its bucket', () => {
  const open = async (thread, messages) => {
    serve({ threads: [thread], messages: { [thread.id]: messages } });
    renderApp(`/inbox/${thread.id}`);
    return screen.findByRole('region', { name: thread.subject });
  };

  it('gives the model’s reason and how sure it was', async () => {
    const thread = makeThread({ subject: 'Kino morgen?', bucket: 'needs_reply', bucketSource: 'model' });
    const pane = await open(thread, [
      makeMessage(thread, { intent: { label: 'needs_reply', confidence: 0.934, reason: 'Mara asks whether Semab is free.', source: 'model' } }),
    ]);
    expect(pane).toHaveTextContent('Needs replySift: Mara asks whether Semab is free. (93% sure)');
  });

  it('says when the user put it there', async () => {
    const thread = makeThread({ subject: 'Termin', bucket: 'do_at_a_time', bucketSource: 'user' });
    const pane = await open(thread, [makeMessage(thread, { intent: { label: 'do_at_a_time', modelLabel: 'read_only', source: 'user' } })]);
    expect(pane).toHaveTextContent('To doYou put it here.');
  });

  it('explains a conversation that needed a reply and has had one', async () => {
    const thread = makeThread({ subject: 'Kino morgen?', bucket: 'waiting_on_them', bucketSource: 'model' });
    const pane = await open(thread, [
      makeMessage(thread, { intent: { label: 'needs_reply', confidence: 0.9, reason: 'Mara asks.', source: 'model' } }),
      makeMessage(thread, { folder: 'sent', from: { name: 'Semab', address: 'semab@sift.example' } }),
    ]);
    expect(pane).toHaveTextContent('WaitingSift said it needed a reply, and you have replied since.');
  });

  it('says nothing for a conversation not sorted yet', async () => {
    const thread = makeThread({ subject: 'Neu' });
    const pane = await open(thread, [makeMessage(thread)]);
    expect(pane).not.toHaveTextContent('Sift:');
  });
});
