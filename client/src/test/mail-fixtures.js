export const SELF = { name: 'Semab', address: 'semab@sift.example' };
export const MARA = { name: 'Mara Klein', address: 'mara@sift.example' };

let sequence = 0;

// A thread shaped like the ones GET /api/threads sends. Each one made is a
// minute older than the one before, so fixtures made in order list in that order.
export function makeThread(overrides = {}) {
  sequence += 1;
  return {
    id: `thread-${sequence}`,
    subject: `Subject ${sequence}`,
    snippet: `Snippet ${sequence}`,
    participants: [MARA, SELF],
    messageCount: 1,
    lastMessageAt: new Date(Date.UTC(2026, 4, 1) - sequence * 60_000).toISOString(),
    folders: ['inbox'],
    hasUnread: false,
    isStarred: false,
    labelIds: [],
    ...overrides,
  };
}

export function makeMessage(thread, overrides = {}) {
  sequence += 1;
  return {
    id: `message-${sequence}`,
    threadId: thread.id,
    from: MARA,
    to: [SELF],
    cc: [],
    subject: thread.subject,
    bodyText: 'Hallo Semab,\nbis morgen.',
    bodyHtml: '',
    snippet: '',
    folder: 'inbox',
    isRead: true,
    isStarred: false,
    isDraft: false,
    sentAt: thread.lastMessageAt,
    attachments: [],
    ...overrides,
  };
}
