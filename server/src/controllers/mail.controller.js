import * as mail from '../services/mail.service.js';

// The response is the sender's copy and thread, and nothing about delivery.
// Saying which recipients have Sift accounts would turn this endpoint into the
// account-probing tool the login route goes out of its way not to be.
export async function send(req, res) {
  const { message, thread } = await mail.sendMessage(req.user, req.valid.body);
  res.status(201).json({ message: message.toJSON(), thread: thread.toJSON() });
}

export async function createDraft(req, res) {
  const draft = await mail.createDraft(req.user, req.valid.body);
  res.status(201).json({ draft: draft.toJSON() });
}

export async function updateDraft(req, res) {
  const draft = await mail.updateDraft(req.user, req.params.id, req.valid.body);
  res.json({ draft: draft.toJSON() });
}

export async function deleteDraft(req, res) {
  await mail.deleteDraft(req.user, req.params.id);
  res.status(204).end();
}

export async function sendDraft(req, res) {
  const { message, thread } = await mail.sendDraft(req.user, req.params.id);
  res.status(201).json({ message: message.toJSON(), thread: thread.toJSON() });
}
