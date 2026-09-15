import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import Dialog from '../components/dialog.jsx';
import Sidebar from '../features/mail/sidebar.jsx';
import ThreadList from '../features/mail/thread-list.jsx';
import ReadingPane from '../features/mail/reading-pane.jsx';
import SearchBox from '../features/mail/search-box.jsx';
import CommandPalette from '../features/mail/command-palette.jsx';
import ShortcutHelp from '../features/mail/shortcut-help.jsx';
import ComposeWindow from '../features/compose/compose-window.jsx';
import { quoteMessage, replyRecipients, replySubject } from '../features/compose/reply.js';
import { FOLDERS, folderName } from '../features/mail/folders.js';
import {
  captureThreads,
  useArchive,
  useLabels,
  useMoveToInbox,
  useSearch,
  useThread,
  useThreadAction,
  useThreadList,
} from '../features/mail/queries.js';
import { useSignedInUser } from '../features/auth/guards.jsx';
import { useLogout } from '../features/auth/session.js';
import { useShortcuts } from '../lib/shortcuts.js';
import NotFound from './not-found.jsx';

const NOTICE_MS = 4000;
// Long enough to spot a mistake and reach for Undo.
const UNDO_MS = 8000;
const noop = () => {};
const COMPOSE_NOTICES = { sent: 'Message sent.', saved: 'Draft saved.', discarded: 'Draft discarded.' };

// What an empty folder says, and a hint where there is something useful to add.
const EMPTY_FOLDERS = {
  inbox: ['Your inbox is empty.', 'Press c to write a message.'],
  sent: ['Nothing sent yet.', null],
  drafts: ['No drafts.', 'A message you close before sending is kept here.'],
  archive: ['Nothing archived yet.', 'Press e on a conversation in the inbox to archive it.'],
  spam: ['No spam.', null],
  trash: ['Trash is empty.', null],
};

// Below lg, the list and the search box above it are hidden while a
// conversation is open. jsdom has no matchMedia, which counts as wide.
const isWide = () => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1024px)').matches;

// Folders and labels on the left, conversations in the middle, the open one on
// the right. What is on screen comes from the address alone, /inbox/<thread>,
// /label/<label>/<thread> or /search/<thread>?q=..., so a reload or a copied
// link opens the same view.
//
// `mode` is "folder", "label" or "search", set by the route.
//
// Narrower screens show fewer panes: below md the sidebar moves into a menu,
// and below lg either the list or the open conversation shows.
export default function Mailbox({ mode }) {
  const { folder, labelId, threadId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useSignedInUser();
  const labels = useLabels();
  const logout = useLogout();
  const archive = useArchive();
  const moveToInbox = useMoveToInbox();
  const star = useThreadAction('star', { onError: () => say('Sift could not star that.') });
  const unstar = useThreadAction('unstar', { onError: () => say('Sift could not take the star off.') });
  const conversation = useThread(threadId);
  const searchRef = useRef(null);

  // The conversation open right now, for work that finishes after the user
  // may have moved on.
  const openNow = useRef(threadId);
  useEffect(() => {
    openNow.current = threadId;
  });

  const query = mode === 'search' ? (searchParams.get('q') ?? '').trim() : '';
  const label = mode === 'label' ? labels.data?.find((candidate) => candidate.id === labelId) : null;
  const notFound = mode === 'folder' ? !folderName(folder) : mode === 'label' && labels.isSuccess && !label;

  const basePath = { folder: `/${folder}`, label: `/label/${labelId}`, search: '/search' }[mode];
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  const listPath = basePath + suffix;
  const threadPath = (id) => `${basePath}/${id}${suffix}`;

  const threadList = useThreadList(mode === 'folder' && !notFound ? { folder } : label ? { label: labelId } : null);
  const search = useSearch(query);
  const pagedThreads = useMemo(() => threadList.data?.pages.flatMap((page) => page.threads) ?? [], [threadList.data]);

  // Paged lists and search results in one shape, so the list and the keys
  // below do not need to know which one is on screen.
  const list =
    mode === 'search'
      ? {
          threads: search.data ?? [],
          isPending: search.isPending,
          isError: search.isError,
          refetch: search.refetch,
          hasNextPage: false,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
          fetchNextPage: noop,
        }
      : {
          threads: pagedThreads,
          isPending: threadList.isPending,
          // A failed later page keeps what loaded and is shown under the rows.
          isError: threadList.isError && !threadList.data,
          refetch: threadList.refetch,
          hasNextPage: threadList.hasNextPage,
          isFetchingNextPage: threadList.isFetchingNextPage,
          isFetchNextPageError: threadList.isFetchNextPageError,
          fetchNextPage: threadList.fetchNextPage,
        };
  const threads = list.threads;
  const openIndex = threads.findIndex((thread) => thread.id === threadId);

  const [dialog, setDialog] = useState(null);
  const [compose, setCompose] = useState(null);
  const [queued, setQueued] = useState(null);
  const [notice, setNotice] = useState(null);
  const [focusSearchWhenClosed, setFocusSearchWhenClosed] = useState(false);

  // A selection belongs to one view. Moving to another folder, label or search
  // starts with nothing selected, and so does coming back.
  const [selection, setSelection] = useState({ view: listPath, ids: [] });
  if (selection.view !== listPath) setSelection({ view: listPath, ids: [] });
  const selectedIds = selection.view === listPath ? selection.ids : [];

  // `undo`, when given, puts an Undo button on the notice and is what z runs.
  function say(text, undo = null) {
    setNotice({ text, undo, at: Date.now() });
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.undo ? UNDO_MS : NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // A command picked in the palette runs once the palette has closed and handed
  // focus back. Run any earlier, and "Search mail" would put the cursor in the
  // search box only for the closing palette to take it away again.
  useEffect(() => {
    if (!queued || dialog !== null) return;
    setQueued(null);
    queued.run();
  }, [queued, dialog]);

  useEffect(() => {
    if (!focusSearchWhenClosed || threadId) return;
    setFocusSearchWhenClosed(false);
    searchRef.current?.focus();
  }, [focusSearchWhenClosed, threadId]);

  function openAt(index) {
    const thread = threads[index];
    // Moving between conversations replaces the history entry, so Back leaves
    // the mailbox view rather than stepping through every message read.
    if (thread) navigate(threadPath(thread.id), { replace: Boolean(threadId) });
  }
  const next = () => openAt(openIndex === -1 ? 0 : Math.min(openIndex + 1, threads.length - 1));
  const previous = () => openAt(Math.max(openIndex - 1, 0));

  function toggleSelected(id) {
    setSelection((current) => {
      const ids = current.view === listPath ? current.ids : [];
      return { view: listPath, ids: ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id] };
    });
  }
  const clearSelection = () => setSelection({ view: listPath, ids: [] });

  // The selection when there is one, otherwise the open conversation.
  const targetIds = () => (selectedIds.length > 0 ? selectedIds : threadId ? [threadId] : []);

  function selectOpen() {
    if (threadId) toggleSelected(threadId);
    else say('Open a conversation to select it.');
  }

  const toggleStar = (thread) => (thread.isStarred ? unstar : star).mutate({ ids: [thread.id] });

  function starTargets() {
    const known = targetIds()
      .map((id) => threads.find((thread) => thread.id === id) ?? (conversation.data?.thread.id === id ? conversation.data.thread : null))
      .filter(Boolean);
    if (known.length === 0) return say('Open or select a conversation to star it.');
    // A selection with some starred and some not gets starred, rather than
    // having the stars it already has taken off.
    const starring = !known.every((thread) => thread.isStarred);
    (starring ? star : unstar).mutate({ ids: known.map((thread) => thread.id) });
  }

  function archiveTargets() {
    const ids = targetIds();
    if (ids.length === 0) return say('Open or select a conversation to archive it.');

    const inInbox = new Set(threads.filter((thread) => thread.folders.includes('inbox')).map((thread) => thread.id));
    const targets = ids.filter((id) => inInbox.has(id));
    if (targets.length === 0) return say('Only conversations in the inbox can be archived.');

    // When the open conversation is archived, the next one down takes its
    // place, skipping any archived with it, or the nearest one above.
    const closing = targets.includes(threadId);
    const staying = (thread) => !targets.includes(thread.id);
    const after = closing
      ? (threads.slice(openIndex + 1).find(staying) ?? threads.slice(0, openIndex).reverse().find(staying))
      : null;
    const reopen = closing ? threadPath(threadId) : null;

    // Taken before the rows leave the list, so Undo can put them back where they were.
    const previousRows = captureThreads(queryClient, targets);
    const archived = archive.mutateAsync({ ids: targets });

    clearSelection();
    if (closing) navigate(after ? threadPath(after.id) : listPath, { replace: true });
    say(
      targets.length === 1 ? 'Conversation archived.' : `${targets.length} conversations archived.`,
      () => undoArchive(targets, reopen, archived, previousRows),
    );

    archived.catch(() => {
      say('Sift could not archive that, so it is back where it was.');
      // Back to it only if the user is still where the archive took them.
      // Pulling them away from somewhere they have gone since would be worse.
      if (closing && openNow.current === after?.id) navigate(reopen, { replace: true });
    });
  }

  // Waits for the archive to reach the server before moving anything back. Sent
  // any sooner, the move back could be applied first, and the conversations
  // would end up archived after all. An archive that failed has already been
  // put back, so there is nothing left to undo.
  async function undoArchive(ids, reopen, archived, previousRows) {
    setNotice(null);
    try {
      await archived;
    } catch {
      return;
    }
    if (reopen) navigate(reopen, { replace: true });
    moveToInbox.mutateAsync({ ids, previous: previousRows }).then(
      () => say(ids.length === 1 ? 'Moved back to the inbox.' : `${ids.length} conversations moved back to the inbox.`),
      () => say('Sift could not undo that.', () => undoArchive(ids, reopen, Promise.resolve(), previousRows)),
    );
  }

  function openCompose(initial) {
    setCompose(initial);
    setDialog('compose');
  }

  const composeNew = () => openCompose({ kind: 'new', to: [], cc: [], bcc: [], subject: '', bodyText: '' });

  function reply(message, { all = false } = {}) {
    const { to, cc } = replyRecipients(message, user.email, { all });
    openCompose({
      kind: all ? 'replyAll' : 'reply',
      threadId: message.threadId,
      to,
      cc,
      bcc: [],
      subject: replySubject(message.subject),
      bodyText: quoteMessage(message),
    });
  }

  // r and a answer the newest message in the open conversation that is not a draft.
  function replyToOpen(options) {
    if (!threadId || !conversation.data) return say('Open a conversation to reply to it.');
    const newest = conversation.data.messages.filter((message) => !message.isDraft).at(-1);
    if (!newest) return say('There is nothing to reply to in this conversation yet.');
    reply(newest, options);
  }

  function continueDraft(draft) {
    const addresses = (people = []) => people.map((person) => person.address);
    openCompose({
      kind: 'draft',
      draftId: draft.id,
      threadId: draft.threadId,
      to: addresses(draft.to),
      cc: addresses(draft.cc),
      bcc: addresses(draft.bcc),
      subject: draft.subject,
      bodyText: draft.bodyText,
    });
  }

  function composeClosed(outcome) {
    setDialog(null);
    setCompose(null);
    if (COMPOSE_NOTICES[outcome]) say(COMPOSE_NOTICES[outcome]);
  }

  function escape() {
    if (selectedIds.length > 0) clearSelection();
    else if (threadId) navigate(listPath);
  }

  function focusSearch() {
    if (threadId && !isWide()) {
      // The box is hidden behind the open conversation. It takes the cursor
      // once the conversation has closed and the list is back on screen.
      navigate(listPath);
      setFocusSearchWhenClosed(true);
      return;
    }
    searchRef.current?.focus();
    searchRef.current?.select();
  }

  useShortcuts(
    {
      j: next,
      k: previous,
      x: selectOpen,
      e: archiveTargets,
      s: starTargets,
      z: () => notice?.undo?.(),
      c: composeNew,
      r: () => replyToOpen(),
      a: () => replyToOpen({ all: true }),
      '/': focusSearch,
      '?': () => setDialog('help'),
      Escape: escape,
      'mod+k': () => setDialog((open) => (open === 'palette' ? null : 'palette')),
    },
    {
      enabled: dialog === null && !notFound,
      // Not while writing: opening the palette would replace the compose
      // window and lose whatever had not been saved yet.
      always: notFound || dialog === 'compose' ? [] : ['mod+k'],
      repeat: ['j', 'k'],
    },
  );

  const commands = [
    { id: 'compose', title: 'Compose', keys: 'c', run: composeNew },
    { id: 'reply', title: 'Reply', keys: 'r', run: () => replyToOpen() },
    { id: 'reply-all', title: 'Reply all', keys: 'a', run: () => replyToOpen({ all: true }) },
    { id: 'next', title: 'Next conversation', keys: 'j', run: next },
    { id: 'previous', title: 'Previous conversation', keys: 'k', run: previous },
    { id: 'archive', title: 'Archive', keys: 'e', run: archiveTargets },
    { id: 'star', title: 'Star or unstar', keys: 's', run: starTargets },
    ...(notice?.undo ? [{ id: 'undo', title: 'Undo archive', keys: 'z', run: notice.undo }] : []),
    { id: 'select', title: 'Select conversation', keys: 'x', run: selectOpen },
    { id: 'search', title: 'Search mail', keys: '/', run: focusSearch },
    ...FOLDERS.map((entry) => ({ id: `folder-${entry.id}`, title: `Go to ${entry.name}`, run: () => navigate(`/${entry.id}`) })),
    ...(labels.data ?? []).map((entry) => ({
      id: `label-${entry.id}`,
      title: `Go to label ${entry.name}`,
      run: () => navigate(`/label/${entry.id}`),
    })),
    { id: 'shortcuts', title: 'Keyboard shortcuts', keys: '?', run: () => setDialog('help') },
    { id: 'sign-out', title: 'Sign out', run: () => logout.mutate() },
  ];

  if (notFound) return <NotFound />;

  const title = mode === 'search' ? 'Search results' : mode === 'label' ? label?.name : folderName(folder);
  const [emptyText, emptyHint] =
    mode === 'search'
      ? [`No conversations match "${query}".`, 'Try other words, or fewer of them.']
      : mode === 'label'
        ? ['No conversations with this label.', null]
        : EMPTY_FOLDERS[folder];

  let listContent;
  if (mode === 'label' && !label) {
    listContent = labels.isError ? (
      <p className="px-4 py-6 text-sm text-stone-500">
        Sift could not load your labels.{' '}
        <button type="button" onClick={() => labels.refetch()} className="text-sky-700 underline">
          Try again
        </button>
      </p>
    ) : (
      <p role="status" className="px-4 py-6 text-sm text-stone-500">
        Loading label
      </p>
    );
  } else if (mode === 'search' && !query) {
    listContent = <p className="px-4 py-6 text-sm text-stone-500">Type in the search box and press Enter.</p>;
  } else {
    listContent = (
      // Keyed by view, so switching folders starts a fresh list at the top.
      <ThreadList
        key={listPath}
        title={title}
        emptyText={emptyText}
        emptyHint={emptyHint}
        list={list}
        basePath={basePath}
        linkSuffix={suffix}
        openId={threadId}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelected}
        onToggleStar={toggleStar}
      />
    );
  }

  return (
    <div className="flex h-dvh bg-white text-stone-900">
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      <div
        className={`${threadId ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col border-r border-stone-200 lg:w-96 lg:flex-none`}
      >
        <SearchBox
          inputRef={searchRef}
          query={query}
          onOpenPalette={() => setDialog('palette')}
          onOpenMenu={() => setDialog('menu')}
        />
        {selectedIds.length > 0 && (
          <div className="flex items-center gap-3 border-b border-stone-200 bg-sky-50 px-4 py-2 text-sm">
            <p className="flex-1">{selectedIds.length} selected</p>
            <button
              type="button"
              onClick={archiveTargets}
              className="rounded-md border border-stone-300 bg-white px-2.5 py-1 hover:bg-stone-100"
            >
              Archive
            </button>
            <button type="button" onClick={clearSelection} className="text-sky-700 underline">
              Clear
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">{listContent}</div>
      </div>

      <div className={`${threadId ? 'flex' : 'hidden lg:flex'} min-w-0 flex-1 flex-col bg-stone-50`}>
        <ReadingPane
          threadId={threadId}
          closeTo={listPath}
          onReply={reply}
          onContinueDraft={continueDraft}
          onToggleStar={toggleStar}
        />
      </div>

      {dialog === 'palette' && (
        <CommandPalette
          commands={commands}
          onClose={() => setDialog(null)}
          onRun={(command) => {
            setDialog(null);
            setQueued(command);
          }}
        />
      )}
      {dialog === 'help' && <ShortcutHelp onClose={() => setDialog(null)} />}
      {dialog === 'menu' && (
        <Dialog label="Menu" side="left" onClose={() => setDialog(null)} className="h-full max-w-[85vw] shadow-xl">
          <Sidebar onNavigate={() => setDialog(null)} />
        </Dialog>
      )}
      {dialog === 'compose' && compose && <ComposeWindow initial={compose} onClose={composeClosed} />}

      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center px-4">
        {notice && (
          <p className="pointer-events-auto flex items-center gap-4 rounded-md bg-stone-900 px-4 py-2 text-sm text-white shadow-lg">
            <span>{notice.text}</span>
            {notice.undo && (
              <button type="button" onClick={notice.undo} className="font-medium text-sky-300 underline">
                Undo
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
