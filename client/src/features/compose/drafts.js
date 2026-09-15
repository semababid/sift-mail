import { api } from '../../lib/api-client.js';
import { labelsKey, threadKey } from '../mail/queries.js';

// Plain calls rather than mutation hooks: the compose window runs its saves in
// a queue of its own, one after another, and needs each result in order.
export const draftApi = {
  create: async (fields) => (await api.post('/api/drafts', fields)).data.draft,
  update: async (id, fields) => (await api.patch(`/api/drafts/${encodeURIComponent(id)}`, fields)).data.draft,
  remove: (id) => api.delete(`/api/drafts/${encodeURIComponent(id)}`),
  send: async (id) => (await api.post(`/api/drafts/${encodeURIComponent(id)}/send`)).data,
};

// Once a message is sent, or a draft kept or thrown away, the lists showing it
// are out of date: Drafts, Sent, its conversation, and any search. Autosaves
// leave them alone, or every pause in typing would reload the list on screen.
export function refreshAfterCompose(queryClient, threadId) {
  queryClient.invalidateQueries({ queryKey: ['threads'] });
  queryClient.invalidateQueries({ queryKey: ['search'], refetchType: 'none' });
  queryClient.invalidateQueries({ queryKey: labelsKey });
  if (threadId) queryClient.invalidateQueries({ queryKey: threadKey(threadId) });
}
