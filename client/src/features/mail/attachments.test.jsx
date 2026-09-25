import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { makeMessage, makeThread } from '../../test/mail-fixtures.js';
import { giveElementsASize, serve } from '../../test/mailbox.js';
import { renderApp } from '../../test/render.jsx';

giveElementsASize();

const PDF = { filename: 'Mietvertrag.pdf', contentType: 'application/pdf', size: 14_500, stored: true };
const VIDEO = { filename: 'Urlaub.mp4', contentType: 'video/mp4', size: 40 * 1024 * 1024, stored: false };

// jsdom has no object URLs and does not follow a download link. These record
// what the page asked the browser to save.
let saved;
beforeEach(() => {
  saved = [];
  URL.createObjectURL = vi.fn((blob) => {
    saved.push({ blob });
    return `blob:sift/${saved.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function recordDownload() {
    saved.at(-1).href = this.href;
    saved.at(-1).filename = this.download;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

async function openMessageWith(attachments, files = {}) {
  const thread = makeThread({ subject: 'Vertrag' });
  const message = makeMessage(thread, { attachments });
  const mail = serve({ threads: [thread], messages: { [thread.id]: [message] } });
  mail.state.files = Object.fromEntries(Object.entries(files).map(([index, bytes]) => [`${message.id}/${index}`, bytes]));
  const view = renderApp(`/inbox/${thread.id}`);
  const list = await screen.findByRole('list', { name: 'Attachments' });
  return { mail, message, list, ...view };
}

describe('attachments in the reading pane', () => {
  it('lists each file with its size, and says which were too large to keep', async () => {
    const { list } = await openMessageWith([PDF, VIDEO]);

    expect(within(list).getByRole('button', { name: 'Download Mietvertrag.pdf, 14 KB' })).toBeInTheDocument();
    expect(list).toHaveTextContent('Urlaub.mp4 · 40 MB · too large to keep');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('shows no list for a message without attachments', async () => {
    const thread = makeThread({ subject: 'Ohne' });
    serve({ threads: [thread], messages: { [thread.id]: [makeMessage(thread)] } });
    renderApp(`/inbox/${thread.id}`);

    await screen.findByRole('region', { name: 'Ohne' });
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('downloads the file under its own name', async () => {
    const { user, list } = await openMessageWith([PDF], { 0: '%PDF-1.4 der Vertrag' });

    await user.click(within(list).getByRole('button', { name: /Mietvertrag\.pdf/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ href: 'blob:sift/1', filename: 'Mietvertrag.pdf' });
    expect(await saved[0].blob.text()).toBe('%PDF-1.4 der Vertrag');
    // Done, with nothing left on screen but the file itself.
    await waitFor(() => expect(within(list).queryByRole('status')).not.toBeInTheDocument());
  });

  it('asks for the second file by its position on the message', async () => {
    const second = { ...PDF, filename: 'Anlage.pdf' };
    const { user, list } = await openMessageWith([PDF, second], { 1: 'zweite Datei' });

    await user.click(within(list).getByRole('button', { name: /Anlage\.pdf/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(await saved[0].blob.text()).toBe('zweite Datei');
  });

  it('says when the file is no longer there', async () => {
    const { user, list } = await openMessageWith([PDF]);

    await user.click(within(list).getByRole('button', { name: /Mietvertrag\.pdf/ }));
    expect(await within(list).findByText('No longer available')).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it('says when the download failed for some other reason, and lets it be tried again', async () => {
    const { user, list, mail } = await openMessageWith([PDF], { 0: 'inhalt' });
    mail.state.fileStatus = 500;

    const button = within(list).getByRole('button', { name: /Mietvertrag\.pdf/ });
    await user.click(button);
    expect(await within(list).findByText('Could not download')).toBeInTheDocument();

    mail.state.fileStatus = null;
    await user.click(button);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(within(list).queryByText('Could not download')).not.toBeInTheDocument();
  });
});
