import * as threadService from '../services/thread.service.js';

export async function list(req, res) {
  const { folder, cursor } = req.valid.query;
  const limit = req.valid.query.limit ?? req.user.settings.messagesPerPage;

  const { threads, nextCursor } = await threadService.listThreads(req.userId, { folder, limit, cursor });
  res.json({ threads: threads.map((t) => t.toJSON()), nextCursor });
}

// Reading a thread does not mark it read. GET has to stay free of side effects,
// or a client that prefetches the next thread would clear unread flags on mail
// nobody opened. Marking read is its own call, in 2.4.
export async function show(req, res) {
  const { thread, messages } = await threadService.getThread(req.userId, req.params.id);
  res.json({ thread: thread.toJSON(), messages: messages.map((m) => m.toJSON()) });
}
