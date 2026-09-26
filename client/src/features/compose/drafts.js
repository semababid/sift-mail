import { api } from '../../lib/api-client.js';
import { labelsKey, threadKey } from '../mail/queries.js';

// Plain calls rather than mutation hooks: the compose window runs its saves in
// a queue of its own, one after another, and needs each result in order.
export const draftApi = {
  create: async (fields) => (await api.post('/api/drafts', fields)).data.draft,
  update: async (id, fields) => (await api.patch(`/api/drafts/${encodeURIComponent(id)}`, fields)).data.draft,
  remove: (id) => api.delete(`/api/drafts/${encodeURIComponent(id)}`),
  send: async (id) => (await api.post(`/api/drafts/${encodeURIComponent(id)}/send`)).data,
  // The file goes as the raw body, with its name and type alongside. It is
  // handed over as the File itself, which the browser streams from disk.
  // Reading it into memory first would load a 2 GB video into the tab before
  // the server could say it was too large.
  upload: async (id, file) =>
    (
      await api.post(`/api/drafts/${encodeURIComponent(id)}/attachments`, file, {
        params: { filename: file.name, type: file.type || undefined },
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    ).data.draft,
  removeAttachment: async (id, attachmentId) =>
    (await api.delete(`/api/drafts/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`)).data.draft,
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
