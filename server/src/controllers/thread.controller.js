import * as threadService from '../services/thread.service.js';

export async function list(req, res) {
  const { folder, label, bucket, cursor } = req.valid.query;
  const limit = req.valid.query.limit ?? req.user.settings.messagesPerPage;

  const { threads, nextCursor } = await threadService.listThreads(req.userId, { folder, label, bucket, limit, cursor });
  res.json({ threads: threads.map((t) => t.toJSON()), nextCursor });
}

// Reading a thread does not mark it read. GET has to stay free of side effects,
// or a client that prefetches the next thread would clear unread flags on mail
// nobody opened. Marking read is its own call, in 2.4.
export async function show(req, res) {
  const { thread, messages } = await threadService.getThread(req.userId, req.params.id);
  res.json({ thread: thread.toJSON(), messages: messages.map((m) => m.toJSON()) });
}

// Answers with the updated threads so the client can reconcile its optimistic
// update. Ids that are not the user's are left out, never reported as errors.
export async function batch(req, res) {
  const { ids, action, labelId, bucket } = req.valid.body;
  const threads = await threadService.applyThreadAction(req.userId, ids, action, { labelId, bucket });
  res.json({ threads: threads.map((t) => t.toJSON()) });
}

export async function buckets(req, res) {
  res.json({ buckets: await threadService.countBuckets(req.userId, req.valid.query) });
}
