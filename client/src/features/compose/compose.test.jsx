import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { messageDate } from '../../lib/format.js';
import { MARA, SELF, makeMessage, makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, numbered, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';
import { timing } from './compose-window.jsx';

giveElementsASize();

// A short pause, so autosave happens within a test instead of after a second
// and a half.
const realAutosaveMs = timing.autosaveMs;
beforeAll(() => {
  timing.autosaveMs = 40;
});
afterAll(() => {
  timing.autosaveMs = realAutosaveMs;
});

const JONAS = { name: 'Jonas Weber', address: 'jonas@sift.example' };
const LENA = { name: 'Lena Roth', address: 'lena@sift.example' };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const composeWindow = (name) => screen.getByRole('dialog', { name });
const calls = (mail) => mail.state.draftLog.map((entry) => entry.call);

async function openInbox(fixtures = { threads: numbered(1) }) {
  const mail = serve(fixtures);
  const view = renderApp('/inbox');
  await findList('Inbox');
  return { mail, ...view };
}

// A conversation with Mara: her message, then Semab's answer to her and Jonas.
function conversationWithMara(overrides = {}) {
  const thread = makeThread({ subject: 'AW: Mietvertrag', messageCount: 2 });
  const fromMara = makeMessage(thread, {
    from: MARA,
    to: [SELF],
    bodyText: 'Hallo Semab,\nanbei der Vertrag.',
    sentAt: '2026-04-29T09:00:00.000Z',
    ...overrides.fromMara,
  });
  const fromMe = makeMessage(thread, {
    from: SELF,
    to: [MARA, JONAS],
    bodyText: 'Danke, schaue ich mir an.',
    sentAt: '2026-04-30T10:00:00.000Z',
    ...overrides.fromMe,
  });
  return { thread, fromMara, fromMe, messages: overrides.onlyMara ? [fromMara] : [fromMara, fromMe] };
}

// Mara's message, then a draft answer Semab has not finished, newest of the two.
async function openConversationWithDraft() {
  const { thread, fromMara } = conversationWithMara({ onlyMara: true });
  const draft = makeMessage(thread, {
    from: SELF,
    to: [MARA],
    subject: 'Re: Mietvertrag',
    bodyText: 'Halb fertig',
    isDraft: true,
    folder: 'drafts',
    sentAt: '2026-04-30T12:00:00.000Z',
  });
  const mail = serve({ threads: [thread], messages: { [thread.id]: [fromMara, draft] }, drafts: [draft] });
  const view = renderApp(`/inbox/${thread.id}`);
  await screen.findByRole('region', { name: 'AW: Mietvertrag' });
  const continueButton = () =>
    within(screen.getByRole('article', { name: 'From me' })).getByRole('button', { name: 'Continue draft' });
  return { mail, draft, continueButton, ...view };
}

describe('writing a new message', () => {
  it('c opens it with the cursor in To, and closing it untouched keeps nothing', async () => {
    const { mail, user } = await openInbox();

    await user.keyboard('c');
    expect(within(composeWindow('New message')).getByLabelText('To')).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await wait(100);
    expect(mail.state.draftLog).toEqual([]);
    expect(screen.queryByText('Draft saved.')).not.toBeInTheDocument();
  });

  it('saves a draft once typing pauses, then keeps updating that same draft', async () => {
    const { mail, user } = await openInbox();

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await waitFor(() => expect(mail.state.draftLog).toHaveLength(1));
    expect(within(composeWindow('New message')).getByRole('status')).toHaveTextContent('Draft saved');

    await user.click(screen.getByLabelText('Subject'));
    await user.paste('Wohnung');
    await waitFor(() => expect(mail.state.draftLog).toHaveLength(2));
    await wait(100);

    expect(mail.state.draftLog).toEqual([
      { call: 'POST /api/drafts', body: { to: ['mara@sift.example'], cc: [], bcc: [], subject: '', bodyText: '' } },
      {
        call: 'PATCH /api/drafts/draft-1',
        body: { to: ['mara@sift.example'], cc: [], bcc: [], subject: 'Wohnung', bodyText: '' },
      },
    ]);
  });

  it('creates one draft, not two, when a save is still on its way as the next one starts', async () => {
    const { mail, user } = await openInbox();
    mail.state.draftDelay = 150;

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await waitFor(() => expect(calls(mail)).toEqual(['POST /api/drafts']));
    await user.click(screen.getByLabelText('Subject'));
    await user.paste('Wohnung');

    await waitFor(() => expect(calls(mail)).toEqual(['POST /api/drafts', 'PATCH /api/drafts/draft-1']), { timeout: 1500 });
    await wait(250);
    expect(calls(mail)).toEqual(['POST /api/drafts', 'PATCH /api/drafts/draft-1']);
  });

  it('sends with Ctrl+Enter, closes, and reloads the lists', async () => {
    const { mail, user } = await openInbox();
    const listLoads = mail.count('GET /api/threads');

    await user.keyboard('c');
    await user.paste('Mara Klein <mara@sift.example>');
    await user.click(screen.getByLabelText('Subject'));
    await user.paste('Wohnung');
    await user.click(screen.getByLabelText('Message'));
    await user.paste('Hallo Mara');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mail.state.sent).toEqual([
      expect.objectContaining({ to: [{ address: 'mara@sift.example' }], subject: 'Wohnung', bodyText: 'Hallo Mara' }),
    ]);
    expect(mail.state.drafts.size).toBe(0);
    await waitFor(() => expect(mail.count('GET /api/threads')).toBeGreaterThan(listLoads));
  });

  it('will not send without a recipient, or to an address that cannot be right', async () => {
    const { mail, user } = await openInbox();

    await user.keyboard('c');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one recipient.');

    await user.click(screen.getByLabelText('To'));
    await user.paste('mara@sift.example, jonas@');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Check this address: jonas@');

    await wait(100);
    expect(calls(mail).filter((call) => call.endsWith('/send'))).toEqual([]);
    expect(composeWindow('New message')).toBeInTheDocument();
  });

  it('stays open with the draft kept when sending fails, and sends on a second try', async () => {
    const { mail, user } = await openInbox();
    mail.state.sendStatus = 500;

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sift could not send this. Your draft is saved, so you can try again.',
    );
    expect(composeWindow('New message')).toBeInTheDocument();
    expect(mail.state.drafts.size).toBe(1);

    mail.state.sendStatus = null;
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    expect(mail.state.sent).toHaveLength(1);
  });

  it('sends once when Send is pressed twice in a row', async () => {
    const { mail, user } = await openInbox();
    mail.state.sendDelay = 100;

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await user.keyboard('{Control>}{Enter}{Enter}{/Control}');

    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    expect(calls(mail).filter((call) => call.endsWith('/send'))).toEqual(['POST /api/drafts/draft-1/send']);
  });

  it('Discard deletes the saved draft', async () => {
    const { mail, user } = await openInbox();

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await waitFor(() => expect(calls(mail)).toEqual(['POST /api/drafts']));

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Draft discarded.')).toBeInTheDocument();
    expect(calls(mail)).toEqual(['POST /api/drafts', 'DELETE /api/drafts/draft-1']);
    expect(mail.state.drafts.size).toBe(0);
  });

  it('says when the draft cannot be saved, and closes without it only when asked again', async () => {
    const { mail, user } = await openInbox();
    mail.state.draftStatus = 500;

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await waitFor(() => expect(within(composeWindow('New message')).getByRole('status')).toHaveTextContent('Not saved'));

    await user.keyboard('{Escape}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sift could not save this draft. Close again to throw it away.',
    );
    expect(composeWindow('New message')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Draft saved.')).not.toBeInTheDocument();
  });

  it('ignores Ctrl+K while writing, so the palette cannot take the message’s place', async () => {
    const { user } = await openInbox();

    await user.keyboard('c');
    await user.paste('mara@sift.example');
    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(composeWindow('New message')).getByLabelText('To')).toHaveValue('mara@sift.example');
  });
});

describe('replying', () => {
  it('r answers the newest message, quoting it, with the cursor above the quote', async () => {
    const { thread, fromMara, messages } = conversationWithMara({ onlyMara: true });
    const mail = serve({ threads: [thread], messages: { [thread.id]: messages } });
    const { user } = renderApp(`/inbox/${thread.id}`);
    await screen.findByRole('region', { name: 'AW: Mietvertrag' });

    await user.keyboard('r');
    const dialog = composeWindow('Reply');
    expect(within(dialog).getByLabelText('To')).toHaveValue('mara@sift.example');
    expect(within(dialog).queryByLabelText('Cc')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Re: Mietvertrag');

    const body = within(dialog).getByLabelText('Message');
    expect(body).toHaveValue(`\n\nOn ${messageDate(fromMara.sentAt)}, Mara Klein wrote:\n> Hallo Semab,\n> anbei der Vertrag.`);
    expect(body).toHaveFocus();
    expect(body.selectionStart).toBe(0);

    await user.paste('Danke!');
    await waitFor(() => expect(calls(mail)).toEqual(['POST /api/drafts']));
    const [{ body: stored }] = mail.state.draftLog;
    expect(stored).toMatchObject({ threadId: thread.id, to: ['mara@sift.example'], subject: 'Re: Mietvertrag' });
    expect(stored.bodyText.startsWith('Danke!\n\nOn ')).toBe(true);
  });

  it('a answers everyone on the message except yourself', async () => {
    const { thread, messages } = conversationWithMara({
      onlyMara: true,
      fromMara: { to: [SELF, JONAS], cc: [LENA, SELF] },
    });
    serve({ threads: [thread], messages: { [thread.id]: messages } });
    const { user } = renderApp(`/inbox/${thread.id}`);
    await screen.findByRole('region', { name: 'AW: Mietvertrag' });

    await user.keyboard('a');
    const dialog = composeWindow('Reply all');
    expect(within(dialog).getByLabelText('To')).toHaveValue('mara@sift.example, jonas@sift.example');
    expect(within(dialog).getByLabelText('Cc')).toHaveValue('lena@sift.example');
    expect(within(dialog).getByLabelText('Bcc')).toHaveValue('');
  });

  it('follows up with your own recipients, and each message has its own Reply', async () => {
    const { thread, messages } = conversationWithMara();
    serve({ threads: [thread], messages: { [thread.id]: messages } });
    const { user } = renderApp(`/inbox/${thread.id}`);
    await screen.findByRole('region', { name: 'AW: Mietvertrag' });

    // The newest message is Semab's own, to Mara and Jonas.
    await user.keyboard('r');
    expect(within(composeWindow('Reply')).getByLabelText('To')).toHaveValue('mara@sift.example, jonas@sift.example');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Mara's message went to Semab alone, so it offers Reply but not Reply all.
    const maras = screen.getByRole('article', { name: 'From Mara Klein' });
    expect(within(maras).queryByRole('button', { name: 'Reply all' })).not.toBeInTheDocument();
    await user.click(within(maras).getByRole('button', { name: 'Reply' }));
    const dialog = composeWindow('Reply');
    expect(within(dialog).getByLabelText('To')).toHaveValue('mara@sift.example');
    expect(within(dialog).getByLabelText('Message').value).toContain('> anbei der Vertrag.');
  });

  it('throws away a reply left as it opened, and keeps one with something written in it', async () => {
    const { thread, messages } = conversationWithMara({ onlyMara: true });
    const mail = serve({ threads: [thread], messages: { [thread.id]: messages } });
    const { user } = renderApp(`/inbox/${thread.id}`);
    await screen.findByRole('region', { name: 'AW: Mietvertrag' });

    await user.keyboard('r');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await wait(100);
    expect(mail.state.draftLog).toEqual([]);
    // Nothing was kept, so nothing may claim it was.
    expect(screen.queryByText('Draft saved.')).not.toBeInTheDocument();

    const detailLoads = mail.count(`GET /api/threads/${thread.id}`);
    await user.keyboard('r');
    await user.paste('Danke!');
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(calls(mail)).toEqual(['POST /api/drafts']);
    expect(mail.state.drafts.size).toBe(1);
    // The conversation loads again, so the draft shows up in it.
    await waitFor(() => expect(mail.count(`GET /api/threads/${thread.id}`)).toBeGreaterThan(detailLoads));
  });

  it('sends a reply left exactly as it opened, storing it first', async () => {
    const { thread, messages } = conversationWithMara({ onlyMara: true });
    const mail = serve({ threads: [thread], messages: { [thread.id]: messages } });
    const { user } = renderApp(`/inbox/${thread.id}`);
    await screen.findByRole('region', { name: 'AW: Mietvertrag' });

    await user.keyboard('r');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    expect(calls(mail)).toEqual(['POST /api/drafts', 'POST /api/drafts/draft-1/send']);
    expect(mail.state.sent[0]).toMatchObject({ to: [{ address: 'mara@sift.example' }], subject: 'Re: Mietvertrag' });
    expect(mail.state.sent[0].bodyText).toContain('> anbei der Vertrag.');
  });

  it('says so when r is pressed with no conversation open', async () => {
    const { mail, user } = await openInbox();

    await user.keyboard('r');
    expect(await screen.findByText('Open a conversation to reply to it.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mail.state.draftLog).toEqual([]);
  });

  it('r answers the last message that was sent, not a draft written after it', async () => {
    const { mail, user } = await openConversationWithDraft();

    await user.keyboard('r');
    const body = within(composeWindow('Reply')).getByLabelText('Message');
    expect(body.value).toContain('Mara Klein wrote:\n> Hallo Semab,');
    expect(body.value).not.toContain('Halb fertig');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mail.state.draftLog).toEqual([]);
  });
});

describe('carrying on with a draft', () => {
  it('opens a saved draft from its conversation and saves into that same draft', async () => {
    const { mail, draft, continueButton, user } = await openConversationWithDraft();

    await user.click(continueButton());
    const dialog = composeWindow('Draft');
    expect(within(dialog).getByLabelText('To')).toHaveValue('mara@sift.example');
    const body = within(dialog).getByLabelText('Message');
    expect(body).toHaveValue('Halb fertig');
    expect(body).toHaveFocus();
    expect(body.selectionStart).toBe('Halb fertig'.length);

    await user.paste(' und fertig');
    await waitFor(() =>
      expect(mail.state.draftLog).toEqual([
        {
          call: `PATCH /api/drafts/${draft.id}`,
          body: { to: ['mara@sift.example'], cc: [], bcc: [], subject: 'Re: Mietvertrag', bodyText: 'Halb fertig und fertig' },
        },
      ]),
    );

    await user.keyboard('{Escape}');
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(mail.state.drafts.get(draft.id).bodyText).toBe('Halb fertig und fertig');
  });

  it('keeps a reopened draft that is closed again without changes', async () => {
    const { mail, draft, continueButton, user } = await openConversationWithDraft();

    await user.click(continueButton());
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();

    await wait(100);
    expect(mail.state.draftLog).toEqual([]);
    expect(mail.state.drafts.has(draft.id)).toBe(true);
  });
});
