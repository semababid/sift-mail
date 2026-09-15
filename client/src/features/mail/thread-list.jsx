import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSignedInUser } from '../auth/guards.jsx';
import { conversationWith, listDate } from '../../lib/format.js';
import { useThreadList } from './queries.js';

// Every row is the same height, so no row has to be measured and a scroll
// position maps straight to a row.
export const ROW_HEIGHT = 84;

// How close to the last loaded row the list gets before it fetches the next page.
const PREFETCH_ROWS = 15;

// Only the rows in view, plus a few either side, are in the DOM. A folder of a
// thousand conversations costs the same to scroll as one of twenty.
export default function ThreadList({ view, title, basePath, selectedId }) {
  const user = useSignedInUser();
  const list = useThreadList(view);
  const scrollRef = useRef(null);

  const threads = useMemo(() => list.data?.pages.flatMap((page) => page.threads) ?? [], [list.data]);

  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  });
  const rows = virtualizer.getVirtualItems();

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  const nearTheEnd = threads.length > 0 && (rows.at(-1)?.index ?? -1) >= threads.length - PREFETCH_ROWS;

  useEffect(() => {
    // After a page fails, nothing more is fetched until the user asks. Trying
    // again on every render would keep hitting a server that is already failing.
    if (nearTheEnd && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) fetchNextPage();
  }, [nearTheEnd, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  return (
    <section aria-labelledby="thread-list-title" className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-stone-200 px-4">
        <h1 id="thread-list-title" className="text-base font-semibold">
          {title}
        </h1>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <ListNote role="status">Loading conversations</ListNote>
        ) : list.isError && !list.data ? (
          <ListNote>
            Sift could not load {title}.{' '}
            <RetryButton onClick={() => list.refetch()} />
          </ListNote>
        ) : threads.length === 0 ? (
          <ListNote>Nothing in {title}.</ListNote>
        ) : (
          <>
            <ul
              aria-label={`Conversations in ${title}`}
              className="relative"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {rows.map((row) => {
                const thread = threads[row.index];
                return (
                  <li
                    key={thread.id}
                    aria-posinset={row.index + 1}
                    aria-setsize={hasNextPage ? -1 : threads.length}
                    className="absolute inset-x-0 top-0"
                    style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                  >
                    <ThreadRow
                      thread={thread}
                      to={`${basePath}/${thread.id}`}
                      selected={thread.id === selectedId}
                      selfAddress={user.email}
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

function ThreadRow({ thread, to, selected, selfAddress }) {
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
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Link
      to={to}
      aria-label={spoken}
      aria-current={selected ? 'true' : undefined}
      className={`flex h-full flex-col justify-center gap-0.5 border-b border-stone-100 px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-inset ${
        selected ? 'bg-sky-100/70' : 'hover:bg-stone-50'
      }`}
    >
      <span className="flex items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate ${strong || 'text-stone-600'}`}>
          {who}
          {thread.messageCount > 1 && <span className="font-normal text-stone-400"> {thread.messageCount}</span>}
        </span>
        {thread.isStarred && (
          <span aria-hidden="true" className="text-amber-500">
            ★
          </span>
        )}
        <time dateTime={thread.lastMessageAt} className={`shrink-0 text-xs ${strong || 'text-stone-500'}`}>
          {listDate(thread.lastMessageAt)}
        </time>
      </span>
      <span className={`truncate ${strong || 'text-stone-700'}`}>{thread.subject || '(no subject)'}</span>
      <span className="truncate text-stone-500">{thread.snippet}</span>
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
