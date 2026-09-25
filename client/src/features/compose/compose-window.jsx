import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Dialog from '../../components/dialog.jsx';
import { formatAddressList, parseAddressList } from '../../lib/addresses.js';
import { formatSize } from '../../lib/format.js';
import { IS_MAC, MOD_LABEL } from '../../lib/shortcuts.js';
import { draftApi, refreshAfterCompose } from './drafts.js';

// How long typing has to pause before the draft is saved. An object, so tests
// can shorten it.
export const timing = { autosaveMs: 1500 };

const TITLES = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', draft: 'Draft' };
const STATUS_TEXT = { idle: '', saving: 'Saving', saved: 'Draft saved', failed: 'Not saved' };
const FIELDS = ['to', 'cc', 'bcc', 'subject', 'body'];

// What gets stored. Addresses that do not parse are left out: the server
// refuses a whole draft over one bad address, and a half-typed address should
// not keep the rest from being saved. The field still shows it, and Send
// points at it.
function toStored(form) {
  return {
    to: parseAddressList(form.to).addresses,
    cc: parseAddressList(form.cc).addresses,
    bcc: parseAddressList(form.bcc).addresses,
    subject: form.subject,
    bodyText: form.body,
  };
}

// `initial` comes from the mailbox: empty for a new message, filled in for a
// reply, or a stored draft to carry on with. `onClose` gets "sent", "saved",
// "discarded", or null when nothing was kept.
export default function ComposeWindow({ initial, onClose }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    to: formatAddressList(initial.to),
    cc: formatAddressList(initial.cc),
    bcc: formatAddressList(initial.bcc),
    subject: initial.subject,
    body: initial.bodyText,
  }));
  const [initialForm] = useState(form);
  const [showCopies, setShowCopies] = useState(initial.cc.length + initial.bcc.length > 0);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [confirmLoss, setConfirmLoss] = useState(false);
  // Files on the draft, as the server last listed them, and files still on
  // their way up.
  const [attachments, setAttachments] = useState(initial.attachments ?? []);
  const [uploading, setUploading] = useState([]);

  const formRef = useRef(form);
  const draftId = useRef(initial.draftId ?? null);
  // What the server holds. A reply starts out equal to it without being
  // stored, so nothing is saved until the user actually writes something.
  const storedKey = useRef(JSON.stringify(toStored(form)));
  const queue = useRef(Promise.resolve(true));
  // Set while sending, closing or discarding, so a second press of any of them
  // does nothing until the first has finished.
  const busy = useRef(false);
  const toRef = useRef(null);
  const bodyRef = useRef(null);
  const attachmentsRef = useRef(attachments);
  // Counts uploads that failed, so a send can tell whether one it waited for
  // went wrong.
  const failedUploads = useRef(0);

  useEffect(() => {
    formRef.current = form;
  });

  // The ref changes with the state, not after the next render: closing the
  // window reads it straight after an upload finishes, before React has had a
  // chance to render, and a stale empty list there threw the draft away.
  function showAttachments(list) {
    attachmentsRef.current = list;
    setAttachments(list);
  }

  // A new message starts in To. A reply starts above the quote, and a draft
  // carries on where its text ends.
  useEffect(() => {
    if (initial.kind === 'new') {
      toRef.current.focus();
      return;
    }
    const body = bodyRef.current;
    const at = initial.kind === 'draft' ? body.value.length : 0;
    body.focus();
    body.setSelectionRange(at, at);
    body.scrollTop = 0;
  }, [initial.kind]);

  // Saves run one after another. Two at once could each create a draft, or an
  // older update could arrive after a newer one and undo it. Resolves to
  // whether the server now holds what the form shows.
  //
  // A form that matches what was last stored is skipped, unless `needDraft` is
  // set: sending goes through a stored draft, and a reply sent as it opened
  // has never been stored at all.
  function save(options) {
    queue.current = queue.current.then(() => writeDraft(options));
    return queue.current;
  }

  // The work of one save, for code already running in the queue.
  async function writeDraft({ needDraft = false } = {}) {
    const stored = toStored(formRef.current);
    const key = JSON.stringify(stored);
    if (key === storedKey.current && (draftId.current || !needDraft)) return true;

    setStatus('saving');
    try {
      if (draftId.current) {
        await draftApi.update(draftId.current, stored);
      } else {
        const draft = await draftApi.create(initial.threadId ? { ...stored, threadId: initial.threadId } : stored);
        draftId.current = draft.id;
      }
      storedKey.current = key;
      setStatus('saved');
      return true;
    } catch {
      setStatus('failed');
      return false;
    }
  }

  // Files go up one at a time, in the same queue as the saves: a file needs a
  // draft to belong to, and a send waits for the queue, so it cannot leave
  // before a file it was shown with.
  function attachFiles(files) {
    for (const file of files) {
      const entry = { key: `${file.name}-${file.size}-${Math.random()}`, name: file.name, size: file.size };
      setUploading((list) => [...list, entry]);
      queue.current = queue.current.then(async () => {
        try {
          if (!(await writeDraft({ needDraft: true }))) throw new Error('the draft could not be saved');
          const draft = await draftApi.upload(draftId.current, file);
          showAttachments(draft.attachments);
        } catch (uploadError) {
          failedUploads.current += 1;
          setError(uploadMessage(file.name, uploadError));
        } finally {
          setUploading((list) => list.filter((candidate) => candidate !== entry));
        }
        return true;
      });
    }
  }

  function removeAttachment(attachment) {
    queue.current = queue.current.then(async () => {
      try {
        const draft = await draftApi.removeAttachment(draftId.current, attachment.id);
        showAttachments(draft.attachments);
      } catch {
        setError(`${attachment.filename} could not be removed. Try again.`);
      }
      return true;
    });
  }

  useEffect(() => {
    // An autosave that fires while the window is sending or closing finds
    // nothing new to store, because both save first. One during Discard at
    // worst updates the draft just before it is deleted.
    const timer = setTimeout(save, timing.autosaveMs);
    return () => clearTimeout(timer);
    // Only a change to the form restarts the pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  function finish(outcome, threadId = initial.threadId) {
    if (draftId.current || outcome === 'sent') refreshAfterCompose(queryClient, threadId);
    onClose(outcome);
  }

  function stayOpen(message) {
    busy.current = false;
    setSending(false);
    setError(message);
  }

  async function close() {
    if (busy.current) return;
    busy.current = true;

    // After anything still in the queue, since an upload finishing there can
    // turn a blank message into one worth keeping.
    await queue.current;
    const current = formRef.current;
    const noFiles = attachmentsRef.current.length === 0;
    const empty = noFiles && FIELDS.every((name) => !current[name].trim());
    const untouched = !initial.draftId && noFiles && FIELDS.every((name) => current[name] === initialForm[name]);

    if (empty || untouched) {
      // Nothing worth keeping. A draft saved along the way, before the text
      // was deleted again, goes too.
      if (draftId.current) await draftApi.remove(draftId.current).catch(() => {});
      finish(null);
    } else if (await save()) {
      finish('saved');
    } else if (confirmLoss) {
      finish(null);
    } else {
      setConfirmLoss(true);
      stayOpen('Sift could not save this draft. Close again to throw it away.');
    }
  }

  async function discard() {
    if (busy.current) return;
    busy.current = true;
    await queue.current;
    if (!draftId.current) return finish(null);

    try {
      await draftApi.remove(draftId.current);
    } catch (removeError) {
      // Already gone, as when it was sent or deleted in another tab.
      if (removeError.response?.status !== 404) return stayOpen('Sift could not discard this draft. Try again.');
    }
    finish('discarded');
  }

  async function send() {
    if (busy.current) return;

    const current = formRef.current;
    const lists = ['to', 'cc', 'bcc'].map((name) => parseAddressList(current[name]));
    const invalid = lists.flatMap((list) => list.invalid);
    if (invalid.length > 0) {
      return setError(`Check ${invalid.length === 1 ? 'this address' : 'these addresses'}: ${invalid.join(', ')}`);
    }
    if (lists.every((list) => list.addresses.length === 0)) return setError('Add at least one recipient.');

    busy.current = true;
    setSending(true);
    setError(null);
    const failuresBefore = failedUploads.current;

    // Sent as the saved draft, so what goes out is exactly what was stored, and
    // the server's claim on the draft stops it going out twice. Saving waits
    // for uploads still in the queue.
    if (!(await save({ needDraft: true }))) {
      return stayOpen('Sift could not save this message, so it was not sent. Try again.');
    }
    if (failedUploads.current !== failuresBefore) {
      return stayOpen('An attachment could not be added, so the message was not sent. Check the files and send again.');
    }
    try {
      const { thread } = await draftApi.send(draftId.current);
      finish('sent', thread.id);
    } catch {
      stayOpen('Sift could not send this. Your draft is saved, so you can try again.');
    }
  }

  const change = (name) => (event) => setForm((previous) => ({ ...previous, [name]: event.target.value }));

  return (
    <Dialog
      labelledBy="compose-title"
      onClose={close}
      className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (IS_MAC ? event.metaKey : event.ctrlKey)) {
            event.preventDefault();
            send();
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
          <h2 id="compose-title" className="text-sm font-semibold">
            {TITLES[initial.kind]}
          </h2>
          <p role="status" className="text-xs text-stone-500">
            {STATUS_TEXT[status]}
          </p>
        </header>

        <AddressField label="To" name="to" inputRef={toRef} value={form.to} onChange={change('to')} readOnly={sending} />
        {showCopies && (
          <>
            <AddressField label="Cc" name="cc" value={form.cc} onChange={change('cc')} readOnly={sending} />
            <AddressField label="Bcc" name="bcc" value={form.bcc} onChange={change('bcc')} readOnly={sending} />
          </>
        )}
        <div className="flex items-center border-b border-stone-200 px-4">
          <label htmlFor="compose-subject" className="w-16 shrink-0 text-sm text-stone-500">
            Subject
          </label>
          <input
            id="compose-subject"
            value={form.subject}
            onChange={change('subject')}
            readOnly={sending}
            className="min-w-0 flex-1 py-2 text-sm outline-none"
          />
        </div>

        <label htmlFor="compose-body" className="sr-only">
          Message
        </label>
        <textarea
          ref={bodyRef}
          id="compose-body"
          value={form.body}
          onChange={change('body')}
          readOnly={sending}
          className="min-h-64 flex-1 resize-none px-4 py-3 text-sm leading-relaxed outline-none"
        />

        {(attachments.length > 0 || uploading.length > 0) && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-4 pb-3">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-stone-50 py-1 pr-1 pl-3 text-sm"
              >
                <span className="max-w-56 truncate">{attachment.filename}</span>
                <span className="text-stone-500">{formatSize(attachment.size)}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment)}
                  disabled={sending}
                  aria-label={`Remove ${attachment.filename}`}
                  className="rounded px-1.5 text-stone-500 hover:bg-stone-200 disabled:opacity-60"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
            {uploading.map((entry) => (
              <li
                key={entry.key}
                className="inline-flex items-center gap-2 rounded-md border border-dashed border-stone-300 px-3 py-1 text-sm text-stone-500"
              >
                <span className="max-w-56 truncate">{entry.name}</span>
                <span>Uploading</span>
              </li>
            ))}
          </ul>
        )}

        {error && (
          <p role="alert" className="px-4 pb-2 text-sm text-red-600">
            {error}
          </p>
        )}

        <footer className="flex items-center gap-3 border-t border-stone-200 px-4 py-2.5 text-sm">
          <button
            type="submit"
            disabled={sending}
            className="rounded-md bg-sky-700 px-4 py-1.5 font-medium text-white hover:bg-sky-800 disabled:opacity-60"
          >
            {sending ? 'Sending' : 'Send'}
          </button>
          <span className="text-xs text-stone-500">{MOD_LABEL} Enter</span>
          {!showCopies && (
            <button type="button" onClick={() => setShowCopies(true)} className="text-sky-700 underline">
              Cc and Bcc
            </button>
          )}
          {/* A label rather than a button, so the file input itself takes the
              click and the keyboard, and needs no script to open. */}
          <label className="cursor-pointer text-sky-700 underline has-[:disabled]:opacity-60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-300">
            Attach files
            <input
              type="file"
              multiple
              disabled={sending}
              onChange={(event) => {
                attachFiles([...event.target.files]);
                // Cleared, so choosing the same file again still counts as a change.
                event.target.value = '';
              }}
              className="sr-only"
            />
          </label>
          <span className="flex-1" />
          <button type="button" onClick={discard} disabled={sending} className="text-stone-600 hover:underline disabled:opacity-60">
            Discard
          </button>
          <button
            type="button"
            onClick={close}
            disabled={sending}
            className="rounded-md border border-stone-300 px-3 py-1.5 hover:bg-stone-100 disabled:opacity-60"
          >
            Close
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function AddressField({ label, name, inputRef, ...inputProps }) {
  return (
    <div className="flex items-center border-b border-stone-200 px-4">
      <label htmlFor={`compose-${name}`} className="w-16 shrink-0 text-sm text-stone-500">
        {label}
      </label>
      <input
        ref={inputRef}
        id={`compose-${name}`}
        type="text"
        inputMode="email"
        autoComplete="off"
        spellCheck="false"
        className="min-w-0 flex-1 py-2 text-sm outline-none"
        {...inputProps}
      />
    </div>
  );
}

// What to say when a file could not be added, from the server's answer.
function uploadMessage(filename, error) {
  const { status, data } = error.response ?? {};
  if (status === 413) return `${filename} is too large: ${data?.error ?? 'attachments have a size limit'}.`;
  if (data?.code === 'too_many_attachments') return `${filename} was not added: ${data.error}.`;
  return `${filename} could not be attached. Try again.`;
}
