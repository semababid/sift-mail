import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client.js';

export const labelsKey = ['labels'];
export const threadKey = (id) => ['thread', id];
// `view` is { folder } or { label }, the same filter the list endpoint takes.
export const threadListKey = (view) => ['threads', view];

// None of these pass the abort signal on to axios. A query that uses it is
// cancelled as soon as nothing watches it, and strict mode unmounts every
// component once in development, which would send each request twice. A
// request left to finish only fills the cache.

// One folder or label, a page at a time. The server hands back a cursor for the
// next page, or null once there is nothing older.
export function useThreadList(view) {
  return useInfiniteQuery({
    queryKey: threadListKey(view),
    queryFn: async ({ pageParam }) =>
      (await api.get('/api/threads', { params: { ...view, cursor: pageParam ?? undefined } })).data,
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useThread(id) {
  return useQuery({
    queryKey: threadKey(id),
    queryFn: async () => (await api.get(`/api/threads/${encodeURIComponent(id)}`)).data,
  });
}

export function useLabels() {
  return useQuery({
    queryKey: labelsKey,
    queryFn: async () => (await api.get('/api/labels')).data.labels,
  });
}

// Puts a thread the server sent back into every cached list that holds it, and
// into the open conversation, so the change shows without loading lists again.
function replaceCachedThread(queryClient, thread) {
  queryClient.setQueriesData(
    { queryKey: ['threads'] },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          threads: page.threads.map((cached) => (cached.id === thread.id ? thread : cached)),
        })),
      },
  );
  queryClient.setQueryData(threadKey(thread.id), (data) => data && { ...data, thread });
}

// Waits for the server before the row changes. Updating first and rolling back
// on failure comes with the other thread actions in 3.6.
export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => (await api.post('/api/threads/batch', { ids: [id], action: 'markRead' })).data.threads,
    onSuccess: (threads) => {
      for (const thread of threads) replaceCachedThread(queryClient, thread);
      // Unread counts on labels are worked out by the server.
      queryClient.invalidateQueries({ queryKey: labelsKey });
    },
  });
}
