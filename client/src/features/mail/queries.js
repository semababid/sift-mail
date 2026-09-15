import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client.js';

export const labelsKey = ['labels'];
export const threadKey = (id) => ['thread', id];
// `filter` is { folder } or { label }, the same filter the list endpoint takes.
export const threadListKey = (filter) => ['threads', filter];
export const searchKey = (query) => ['search', query];

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

// Keyword search, best match first. Each row shows the snippet of the message
// that matched, which is often not the newest one in its conversation.
export function useSearch(query) {
  return useQuery({
    queryKey: searchKey(query),
    queryFn: async () => {
      const { results } = (await api.get('/api/search', { params: { q: query } })).data;
      return results.map(({ thread, match }) => ({ ...thread, snippet: match.snippet || thread.snippet }));
    },
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

export function useLabels() {
  return useQuery({
    queryKey: labelsKey,
    queryFn: async () => (await api.get('/api/labels')).data.labels,
  });
}

// Whether a thread still belongs in a cached list after it changed. Only a
// folder view loses rows this way, as when archiving takes a conversation out
// of the inbox. Label views and search results keep it wherever it went.
const stillIn = (filter, thread) => !filter?.folder || thread.folders.includes(filter.folder);

// Puts threads the server sent back into every cached list and open
// conversation that holds them, and drops them from folders they left, so the
// change shows without loading any list again.
function applyUpdatedThreads(queryClient, updated) {
  const byId = new Map(updated.map((thread) => [thread.id, thread]));

  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['threads'] })) {
    const filter = query.queryKey[1];
    queryClient.setQueryData(
      query.queryKey,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            threads: page.threads.map((thread) => byId.get(thread.id) ?? thread).filter((thread) => stillIn(filter, thread)),
          })),
        },
    );
  }

  queryClient.setQueriesData({ queryKey: ['search'] }, (data) =>
    data?.map((row) => (byId.has(row.id) ? { ...byId.get(row.id), snippet: row.snippet } : row)),
  );

  for (const thread of updated) {
    queryClient.setQueryData(threadKey(thread.id), (data) => data && { ...data, thread });
  }
}

const threadAction = (action) => async (ids) =>
  (await api.post('/api/threads/batch', { ids, action })).data.threads;

// Both wait for the server before anything changes on screen. Updating first
// and rolling back on failure comes in 3.6.
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => threadAction('markRead')([id]),
    onSuccess: (threads) => {
      applyUpdatedThreads(queryClient, threads);
      // Unread counts on labels are worked out by the server.
      queryClient.invalidateQueries({ queryKey: labelsKey });
    },
  });
}

export function useArchive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: threadAction('archive'),
    onSuccess: (threads) => {
      applyUpdatedThreads(queryClient, threads);
      // The archive folder, and any search, is now missing these changes. They
      // are marked stale without a request, and load fresh when next opened.
      queryClient.invalidateQueries({ queryKey: ['threads'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: ['search'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: labelsKey });
    },
  });
}

// Undo for archive. A conversation coming back has no row in the cached inbox
// to update, so the lists on screen load again and the rest are marked stale.
export function useMoveToInbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: threadAction('moveToInbox'),
    onSuccess: (threads) => {
      applyUpdatedThreads(queryClient, threads);
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['search'], refetchType: 'none' });
      queryClient.invalidateQueries({ queryKey: labelsKey });
    },
  });
}
