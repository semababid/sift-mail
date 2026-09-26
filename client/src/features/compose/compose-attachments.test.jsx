import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { File } from 'node:buffer';
import { screen, waitFor, within } from '@testing-library/react';
import { api } from '../../lib/api-client.js';
import { MARA, SELF, makeMessage, makeThread } from '../../test/mail-fixtures.js';
import { findList, giveElementsASize, numbered, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';
import { timing } from './compose-window.jsx';

giveElementsASize();

const realAutosaveMs = timing.autosaveMs;
beforeAll(() => {
  timing.autosaveMs = 40;
});
afterAll(() => {
  timing.autosaveMs = realAutosaveMs;
});

// Node's File, because a request body built from the test browser's File
// arrives as the text "undefined". A real browser sends either kind as it is.
const pdf = () => new File(['%PDF-1.4 Vertrag'], 'Vertrag.pdf', { type: 'application/pdf' });

afterEach(() => vi.restoreAllMocks());
const notes = () => new File(['Zeile 1'], 'Notizen.txt', { type: 'text/plain' });
const composeWindow = () => screen.getByRole('dialog', { name: 'New message' });
const fileList = () => within(composeWindow()).queryByRole('list', { name: 'Attachments' });
const calls = (mail) => mail.state.draftLog.map((entry) => entry.call);

async function startMessage() {
  const mail = serve({ threads: numbered(1) });
  const view = renderApp('/inbox');
  await findList('Inbox');
  await view.user.keyboard('c');
  await view.user.paste('mara@sift.example');
  return { mail, ...view };
}

const attach = (user, ...files) => user.upload(within(composeWindow()).getByLabelText('Attach files'), files);

describe('attaching files while writing', () => {
  it('saves the draft first, then sends the file up as raw bytes, and lists it', async () => {
    const { mail, user } = await startMessage();

    await attach(user, pdf());
    await waitFor(() => expect(fileList()).toHaveTextContent('Vertrag.pdf'));
    expect(fileList()).toHaveTextContent('16 B');

    expect(calls(mail)[0]).toBe('POST /api/drafts');
    expect(mail.state.uploads).toEqual([
      {
        draftId: 'draft-1',
        filename: 'Vertrag.pdf',
        type: 'application/pdf',
        contentType: 'application/octet-stream',
        text: '%PDF-1.4 Vertrag',
      },
    ]);
  });

  it('hands the file itself to the request, so the browser streams it from disk', async () => {
    const { user } = await startMessage();
    const post = vi.spyOn(api, 'post');
    const file = pdf();

    await attach(user, file);
    await waitFor(() => expect(fileList()).toHaveTextContent('Vertrag.pdf'));
    const upload = post.mock.calls.find(([url]) => url.endsWith('/attachments'));
    // The same object, not a copy of its bytes read into the page first.
    expect(upload[1]).toBe(file);
  });

  it('shows a file as uploading until the server has it', async () => {
    const { mail, user } = await startMessage();
    mail.state.uploadDelay = 150;

    await attach(user, pdf());
    // Inside the file list: the window's other status line is the draft's.
    await waitFor(() => expect(within(fileList()).getByRole('status')).toHaveTextContent('Uploading'));
    await waitFor(() => expect(within(composeWindow()).queryByText('Uploading')).not.toBeInTheDocument());
    expect(within(fileList()).getByRole('button', { name: 'Remove Vertrag.pdf' })).toBeInTheDocument();
  });

  it('sends several files one after another', async () => {
    const { mail, user } = await startMessage();

    await attach(user, pdf(), notes());
    await waitFor(() => expect(within(fileList()).getAllByRole('listitem')).toHaveLength(2));
    expect(mail.state.uploads.map((upload) => upload.filename)).toEqual(['Vertrag.pdf', 'Notizen.txt']);
  });

  it('takes a file off the draft', async () => {
    const { mail, user } = await startMessage();
    await attach(user, pdf());
    await waitFor(() => expect(fileList()).toHaveTextContent('Vertrag.pdf'));

    await user.click(within(fileList()).getByRole('button', { name: 'Remove Vertrag.pdf' }));
    await waitFor(() => expect(fileList()).toBeNull());
    expect(mail.state.removals).toEqual(['att-1']);
  });

  it('says when a file is too large, and does not list it', async () => {
    const { mail, user } = await startMessage();
    mail.state.uploadStatus = 413;

    await attach(user, pdf());
    expect(await within(composeWindow()).findByRole('alert')).toHaveTextContent(
      'Vertrag.pdf is too large: attachments can add up to 25 MB per message.',
    );
    await waitFor(() => expect(fileList()).toBeNull());
  });

  it('keeps a message that has nothing in it but a file', async () => {
    const mail = serve({ threads: numbered(1) });
    const { user } = renderApp('/inbox');
    await findList('Inbox');
    await user.keyboard('c');

    await attach(user, pdf());
    await waitFor(() => expect(fileList()).toHaveTextContent('Vertrag.pdf'));
    await user.keyboard('{Escape}');

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(mail.state.drafts.get('draft-1').attachments).toHaveLength(1);
  });

  it('keeps a message closed while its only file is still on its way', async () => {
    const mail = serve({ threads: numbered(1) });
    const { user } = renderApp('/inbox');
    await findList('Inbox');
    await user.keyboard('c');
    mail.state.uploadDelay = 150;

    await attach(user, pdf());
    await user.keyboard('{Escape}');

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(mail.state.drafts.get('draft-1').attachments).toHaveLength(1);
  });
});

describe('sending with files', () => {
  it('sends the message with its files', async () => {
    const { mail, user } = await startMessage();
    await attach(user, pdf());
    await waitFor(() => expect(fileList()).toHaveTextContent('Vertrag.pdf'));

    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    expect(mail.state.sent[0].attachments.map((a) => a.filename)).toEqual(['Vertrag.pdf']);
  });

  it('waits for an upload still running before it sends', async () => {
    const { mail, user } = await startMessage();
    mail.state.uploadDelay = 200;

    await attach(user, pdf());
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    expect(mail.state.sent[0].attachments.map((a) => a.filename)).toEqual(['Vertrag.pdf']);
  });

  it('does not send when an upload it waited for failed', async () => {
    const { mail, user } = await startMessage();
    mail.state.uploadDelay = 150;
    mail.state.uploadStatus = 500;

    await attach(user, pdf());
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(await within(composeWindow()).findByText(
      'An attachment could not be added, so the message was not sent. Check the files and send again.',
    )).toBeInTheDocument();
    expect(mail.state.sent).toEqual([]);
    expect(calls(mail).filter((call) => call.endsWith('/send'))).toEqual([]);
  });
});

describe('carrying on with a draft', () => {
  it('shows the files the draft already has', async () => {
    const thread = makeThread({ subject: 'Mietvertrag' });
    const fromMara = makeMessage(thread, { from: MARA, to: [SELF] });
    const draft = makeMessage(thread, {
      from: SELF,
      to: [MARA],
      isDraft: true,
      folder: 'drafts',
      bodyText: 'Anbei',
      attachments: [{ id: 'att-7', filename: 'Anlage.pdf', contentType: 'application/pdf', size: 2048, stored: true }],
    });
    serve({ threads: [thread], messages: { [thread.id]: [fromMara, draft] }, drafts: [draft] });
    const { user } = renderApp(`/inbox/${thread.id}`);
    await screen.findByRole('region', { name: 'Mietvertrag' });

    await user.click(screen.getByRole('button', { name: 'Continue draft' }));
    const list = within(screen.getByRole('dialog', { name: 'Draft' })).getByRole('list', { name: 'Attachments' });
    expect(list).toHaveTextContent('Anlage.pdf');
    expect(list).toHaveTextContent('2 KB');
  });
});
