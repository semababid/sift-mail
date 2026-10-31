import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client.js';

export const labelsKey = ['labels'];
export const bucketCountsKey = (folder) => ['buckets', folder];
export const threadKey = (id) => ['thread', id];
// `filter` is { folder } or { label }, with a `bucket` in the inbox, the same
// filter the list endpoint takes.
export const threadListKey = (filter) => ['threads', filter];
export const searchKey = (query, debug = false) => ['search', query, debug];

// None of these pass the abort signal on to axios. A query that uses it is
// cancelled as soon as nothing watches it, and strict mode unmounts every
// component once in development, which would send each request twice. A
// request left to finish only fills the cache.

// One folder or label, a page at a time. The server hands back a cursor for the
// next page, or null once there is nothing older. A null filter waits, as a
// label view does until it knows the label exists.
export function useThreadList(filter) {
  return useInfiniteQuery({
    queryKey: threadListKey(filter),
    queryFn: async ({ pageParam }) =>
      (await api.get('/api/threads', { params: { ...filter, cursor: pageParam ?? undefined } })).data,
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: filter !== null,
  });
}

// Search by keyword and by meaning together, best match first. Each row shows
// the snippet of the message that matched, which is often not the newest one
// in its conversation, and carries what it scored as `found`.
//
// The answer is { threads, mode }: mode is "hybrid", or "keyword" while search
// by meaning cannot run. With `debug` each row's `found` also has its rank and
// score in both searches, and the answer says why meaning was left out.
export function useSearch(query, { debug = false } = {}) {
  return useQuery({
    queryKey: searchKey(query, debug),
    queryFn: async () => {
      const { results, mode, vectorUnavailable } = (
        await api.get('/api/search', { params: { q: query, debug: debug || undefined } })
      ).data;
      return {
        mode,
        vectorUnavailable,
        threads: results.map(({ thread, match, debug: sides }) => ({
          ...thread,
          snippet: match.snippet || thread.snippet,
          found: { score: match.score, ...sides },
        })),
      };
    },
    // Turning scores on or off asks again for the same words. The rows on
    // screen stay while it does, rather than going back to loading.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === query ? previous : undefined),
    enabled: query.length > 0,
  });
}

export function useThread(id) {
  return useQuery({
    queryKey: threadKey(id),
    queryFn: async () => (await api.get(`/api/threads/${encodeURIComponent(id)}`)).data,
    enabled: Boolean(id),
  });
}

// How many conversations each bucket of a folder holds, for its tabs.
export function useBucketCounts(folder, { enabled = true } = {}) {
  return useQuery({
    queryKey: bucketCountsKey(folder),
    queryFn: async () => (await api.get('/api/threads/buckets', { params: { folder } })).data.buckets,
    enabled,
  });
}

export function useLabels() {
  return useQuery({
    queryKey: labelsKey,
    queryFn: async () => (await api.get('/api/labels')).data.labels,
  });
}

// Whether a thread still belongs in a cached list after it changed. Only a
// folder view loses rows this way, as when archiving takes a conversation out
// of the inbox, or moving it takes it out of a bucket tab. Label views and
// search results keep it wherever it went.
const stillIn = (filter, thread) =>
  (!filter?.folder || thread.folders.includes(filter.folder)) && (!filter?.bucket || thread.bucket === filter.bucket);

// Runs `change` over every cached copy of every thread: each list, each search
// and each open conversation. A folder list drops a thread that has left its
// folder. `change` hands back the thread untouched when it is not one of those
// being changed.
function updateCachedThreads(queryClient, change) {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['threads'] })) {
    const filter = query.queryKey[1];
    queryClient.setQueryData(
      query.queryKey,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            threads: page.threads.map(change).filter((thread) => stillIn(filter, thread)),
          })),
        },
    );
  }

  // A thread from the server has its own snippet and no scores. The row keeps
  // the ones the search gave it.
  queryClient.setQueriesData(
    { queryKey: ['search'] },
    (data) =>
      data && {
        ...data,
        threads: data.threads.map((row) => {
          const changed = change(row);
          return changed === row ? row : { ...changed, snippet: row.snippet, found: row.found };
        }),
      },
  );

  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['thread'] })) {
    queryClient.setQueryData(query.queryKey, (data) => data && { ...data, thread: change(data.thread) });
  }
}

// Where these threads stand in the cache right now, and where in each list,
// so they alone can be put back later.
export function captureThreads(queryClient, ids) {
  const wanted = new Set(ids);
  const cache = queryClient.getQueryCache();
  return {
    ids,
    lists: cache
      .findAll({ queryKey: ['threads'] })
      .filter((query) => query.state.data)
      .map((query) => ({
        key: query.queryKey,
        rows: query.state.data.pages.flatMap((page, pageIndex) =>
          page.threads.flatMap((thread, index) => (wanted.has(thread.id) ? [{ pageIndex, index, thread }] : [])),
        ),
      })),
    searches: cache
      .findAll({ queryKey: ['search'] })
      .filter((query) => query.state.data)
      .map((query) => ({
        key: query.queryKey,
        rows: query.state.data.threads.flatMap((thread, index) => (wanted.has(thread.id) ? [{ index, thread }] : [])),
      })),
    details: ids.map((id) => [id, queryClient.getQueryData(threadKey(id))]),
  };
}

// Puts captured threads back as they were: the same version, at the same
// place, and gone again from any list they were not in. Every other row is left
// as it is now, so a failed star cannot undo a star added to another
// conversation since.
function restoreThreads(queryClient, captured) {
  const ids = new Set(captured.ids);
  const putBack = (list, rows) => {
    const others = list.filter((thread) => !ids.has(thread.id));
    for (const { index, thread } of rows) others.splice(Math.min(index, others.length), 0, thread);
    return others;
  };

  for (const { key, rows } of captured.lists) {
    queryClient.setQueryData(
      key,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page, pageIndex) => ({
            ...page,
            threads: putBack(
              page.threads,
              rows.filter((row) => row.pageIndex === pageIndex),
            ),
          })),
        },
    );
  }
  for (const { key, rows } of captured.searches) {
    queryClient.setQueryData(key, (data) => data && { ...data, threads: putBack(data.threads, rows) });
  }
  for (const [id, data] of captured.details) {
    if (data) queryClient.setQueryData(threadKey(id), data);
  }
}

const swapFolder = (folders, from, to) => [...new Set(folders.map((folder) => (folder === from ? to : folder)))];

// What each action looks like before the server has answered. The server's
// answer replaces it: starring, for one, marks only the newest message, and
// the thread it sends back says what that came to.
const LOCAL_CHANGE = {
  markRead: (thread) => ({ ...thread, hasUnread: false }),
  setBucket: (thread, { bucket }) => ({ ...thread, bucket, bucketSource: 'user' }),
  // What the model said is only on the server, so this waits for its answer.
  resetBucket: (thread) => thread,
  star: (thread) => ({ ...thread, isStarred: true }),
  unstar: (thread) => ({ ...thread, isStarred: false }),
  archive: (thread) => ({ ...thread, folders: swapFolder(thread.folders, 'inbox', 'archive') }),
  moveToInbox: (thread) => ({ ...thread, folders: swapFolder(thread.folders, 'archive', 'inbox') }),
};

function refreshAfter(queryClient, action) {
  if (action === 'star' || action === 'unstar') return;
  // Archiving and moving both change how many conversations a bucket holds.
  if (action !== 'markRead') queryClient.invalidateQueries({ queryKey: ['buckets'] });
  // Unread counts on labels are worked out by the server.
  queryClient.invalidateQueries({ queryKey: labelsKey });
  if (action === 'markRead') return;

  // The archive folder and searches are marked stale and load fresh when next
  // opened. An undo also reloads the lists on screen: its rows were put back
  // from the cache, and the server has the last word on what is there.
  queryClient.invalidateQueries({ queryKey: ['threads'], refetchType: action === 'moveToInbox' ? 'active' : 'none' });
  queryClient.invalidateQueries({ queryKey: ['search'], refetchType: 'none' });
}

// A thread action that shows on screen before the server answers. Called with
// { ids }, and for an undo also { previous }, a capture from before the action
// being undone, which is put back first. Anything else given, as the `bucket`
// of setBucket, goes to the server with the ids.
//
// If the server refuses, only these threads return to how they were.
export function useThreadAction(action, { onError } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, previous, ...rest }) => (await api.post('/api/threads/batch', { ids, action, ...rest })).data.threads,
    onMutate: async ({ ids, previous, ...rest }) => {
      // A fetch already on its way would land with the old state and wipe the
      // change out. That includes a list loading its next page: the page is
      // joined onto the rows as they were when the fetch began, not as they are
      // now. The list asks for the page again once it is cancelled, which
      // costs one request. Queries still loading for the first time are left
      // alone: cancelled, one would sit empty with nothing to fetch it again.
      await Promise.all(
        ['threads', 'search', 'thread'].map((name) =>
          queryClient.cancelQueries({ queryKey: [name], predicate: (query) => query.state.data !== undefined }),
        ),
      );
      const captured = captureThreads(queryClient, ids);
      if (previous) restoreThreads(queryClient, previous);
      const targets = new Set(ids);
      updateCachedThreads(queryClient, (thread) => (targets.has(thread.id) ? LOCAL_CHANGE[action](thread, rest) : thread));
      return { captured };
    },
    onError: (error, variables, context) => {
      if (context) restoreThreads(queryClient, context.captured);
      onError?.(error, variables);
    },
    onSuccess: (threads) => {
      const byId = new Map(threads.map((thread) => [thread.id, thread]));
      updateCachedThreads(queryClient, (thread) => byId.get(thread.id) ?? thread);
    },
    onSettled: () => refreshAfter(queryClient, action),
  });
}

export const useMarkRead = () => useThreadAction('markRead');
export const useArchive = () => useThreadAction('archive');
export const useMoveToInbox = () => useThreadAction('moveToInbox');
