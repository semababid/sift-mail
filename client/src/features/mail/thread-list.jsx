import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSignedInUser } from '../auth/guards.jsx';
import Skeleton from '../../components/skeleton.jsx';
import StarButton from '../../components/star-button.jsx';
import { conversationWith, listDate } from '../../lib/format.js';

// Every row is the same height, so no row has to be measured and a scroll
// position maps straight to a row.
export const ROW_HEIGHT = 84;

// How close to the last loaded row the list gets before it fetches the next page.
const PREFETCH_ROWS = 15;
const PLACEHOLDER_ROWS = 8;

// Only the rows in view, plus a few either side, are in the DOM. A folder of a
// thousand conversations costs the same to scroll as one of twenty.
//
// `list` is a folder, a label or search results in one shape, built by the
// mailbox page: the threads loaded so far and how to load more.
//
// Search adds to it: `actions` beside the title, a `note` under it, and with
// `detail` one more line on every row, as { height, show, say }: the row
// height that leaves room for it, the line itself, and the same in words.
export default function ThreadList({
  title,
  emptyText,
  emptyHint,
  list,
  basePath,
  linkSuffix,
  openId,
  selectedIds,
  onToggleSelect,
  onToggleStar,
  actions = null,
  note = null,
  detail = null,
}) {
  const rowHeight = detail?.height ?? ROW_HEIGHT;
  const user = useSignedInUser();
  const scrollRef = useRef(null);
  const { threads, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;

  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });
  const rows = virtualizer.getVirtualItems();

  const nearTheEnd = threads.length > 0 && (rows.at(-1)?.index ?? -1) >= threads.length - PREFETCH_ROWS;

  useEffect(() => {
    // After a page fails, nothing more is fetched until the user asks. Trying
    // again on every render would keep hitting a server that is already failing.
    if (nearTheEnd && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) fetchNextPage();
  }, [nearTheEnd, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  // Keeps the open conversation on screen as j and k move through the list, or
  // when an address opens one far down.
  const openIndex = threads.findIndex((thread) => thread.id === openId);
  useEffect(() => {
    if (openIndex >= 0) virtualizer.scrollToIndex(openIndex, { align: 'auto' });
  }, [openIndex, virtualizer]);

  return (
    <section aria-labelledby="thread-list-title" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-stone-200 px-4">
        <h1 id="thread-list-title" className="flex-1 text-base font-semibold">
          {title}
        </h1>
        {actions}
      </header>
      {note}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <div role="status">
            <span className="sr-only">Loading conversations</span>
            {Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => (
              <div
                key={index}
                className="flex flex-col justify-center gap-2 border-b border-stone-100 pr-4 pl-10"
                style={{ height: rowHeight }}
              >
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <ListNote>
            Sift could not load {title}.{' '}
            <RetryButton onClick={() => list.refetch()} />
          </ListNote>
        ) : threads.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-stone-700">{emptyText}</p>
            {emptyHint && <p className="mt-1 text-sm text-stone-500">{emptyHint}</p>}
          </div>
        ) : (
          <>
            <ul
              aria-label={`Conversations in ${title}`}
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {rows.map((row) => {
                const thread = threads[row.index];
                const checked = selectedIds.includes(thread.id);
                const subject = thread.subject || '(no subject)';
                return (
                  <li
                    key={thread.id}
                    aria-posinset={row.index + 1}
                    aria-setsize={hasNextPage ? -1 : threads.length}
                    className="absolute inset-x-0 top-0"
                    style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleSelect(thread.id)}
                      aria-label={`Select ${subject}`}
                      className="absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 accent-sky-700"
                    />
                    <ThreadRow
                      thread={thread}
                      to={`${basePath}/${thread.id}${linkSuffix}`}
                      open={thread.id === openId}
                      checked={checked}
                      selfAddress={user.email}
                      detail={detail}
                    />
                    <StarButton
                      label={`Star ${subject}`}
                      starred={thread.isStarred}
                      onClick={() => onToggleStar(thread)}
                      className="absolute right-2.5 bottom-2 z-10 text-base"
                    />
                  </li>
                );
              })}
            </ul>
            {isFetchingNextPage && <ListNote role="status">Loading more</ListNote>}
            {isFetchNextPageError && (
              <ListNote>
                Sift could not load more conversations.{' '}
                <RetryButton onClick={() => fetchNextPage()} />
              </ListNote>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ThreadRow({ thread, to, open, checked, selfAddress, detail }) {
  const unread = thread.hasUnread;
  const strong = unread ? 'font-semibold text-stone-900' : '';
  const who = conversationWith(thread.participants, selfAddress);
  const subject = thread.subject || '(no subject)';
  const date = listDate(thread.lastMessageAt);

  // The row's name for screen readers, as one phrase. Built from the contents
  // alone it would run words together ("Mara Klein30 Apr") and miss the unread
  // and star state, which only show as bold text and an icon.
  const spoken = [
    unread && 'Unread',
    thread.isStarred && 'starred',
    thread.messageCount > 1 ? `${who}, ${thread.messageCount} messages` : who,
    subject,
    date,
    detail?.say(thread),
  ]
    .filter(Boolean)
    .join(', ');

  const background = open ? 'bg-sky-100/70' : checked ? 'bg-sky-50' : 'hover:bg-stone-50';

  return (
    <Link
      to={to}
      aria-label={spoken}
      aria-current={open ? 'true' : undefined}
      className={`flex h-full flex-col justify-center gap-0.5 border-b border-stone-100 pr-4 pl-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-inset ${background}`}
    >
      <span className="flex items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate ${strong || 'text-stone-600'}`}>
          {who}
          {thread.messageCount > 1 && <span className="font-normal text-stone-400"> {thread.messageCount}</span>}
        </span>
        <time dateTime={thread.lastMessageAt} className={`shrink-0 text-xs ${strong || 'text-stone-500'}`}>
          {date}
        </time>
      </span>
      <span className={`truncate ${strong || 'text-stone-700'}`}>{subject}</span>
      {/* Room on the right for the star button over this line. */}
      <span className="truncate pr-6 text-stone-500">{thread.snippet}</span>
      {detail?.show(thread)}
    </Link>
  );
}

function ListNote({ children, ...props }) {
  return (
    <p className="px-4 py-6 text-sm text-stone-500" {...props}>
      {children}
    </p>
  );
}

function RetryButton({ onClick }) {
  return (
    <button type="button" onClick={onClick} className="text-sky-700 underline">
      Try again
    </button>
  );
}
