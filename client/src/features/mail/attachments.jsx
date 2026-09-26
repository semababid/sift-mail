import { useState } from 'react';
import { api } from '../../lib/api-client.js';
import { formatSize } from '../../lib/format.js';

// How long a downloaded file's object URL is kept. Revoking it straight after
// the click cancels the download in some browsers.
const RELEASE_URL_MS = 60_000;

// Fetched through the API client, so a session that expired while the message
// was open renews itself first, as it does for every other request. A plain
// link would get a 401 in that case. The file is handed to the browser as a
// download once it has arrived.
async function saveAttachment(messageId, attachmentId, filename) {
  const res = await api.get(`/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), RELEASE_URL_MS);
}

export default function Attachments({ message }) {
  if (!message.attachments?.length) return null;

  return (
    <ul aria-label="Attachments" className="mt-4 flex flex-wrap gap-2">
      {message.attachments.map((attachment) => (
        <li key={attachment.id}>
          <Attachment messageId={message.id} attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

const NOTES = { downloading: 'Downloading', failed: 'Could not download', gone: 'No longer available' };

function Attachment({ messageId, attachment }) {
  const [state, setState] = useState('idle');
  const { filename } = attachment;
  const size = formatSize(attachment.size);

  if (!attachment.stored) {
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-dashed border-stone-300 px-3 py-1.5 text-sm text-stone-500">
        {filename} · {size} · too large to keep
      </span>
    );
  }

  async function download() {
    setState('downloading');
    try {
      await saveAttachment(messageId, attachment.id, filename);
      setState('idle');
    } catch (error) {
      setState(error.response?.status === 404 ? 'gone' : 'failed');
    }
  }

  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <button
        type="button"
        onClick={download}
        disabled={state === 'downloading'}
        aria-label={`Download ${filename}, ${size}`}
        className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-stone-50 px-3 py-1.5 hover:bg-stone-100 disabled:opacity-60"
      >
        <span className="max-w-56 truncate">{filename}</span>
        <span className="text-stone-500">{size}</span>
      </button>
      {NOTES[state] && (
        <span role="status" className={state === 'downloading' ? 'text-stone-500' : 'text-red-600'}>
          {NOTES[state]}
        </span>
      )}
    </span>
  );
}
