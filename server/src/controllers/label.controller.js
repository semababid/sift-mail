import * as labelService from '../services/label.service.js';

export async function list(req, res) {
  res.json({ labels: await labelService.listLabels(req.userId) });
}

export async function create(req, res) {
  const label = await labelService.createLabel(req.userId, req.valid.body);
  res.status(201).json({ label: label.toJSON() });
}

export async function update(req, res) {
  const label = await labelService.updateLabel(req.userId, req.params.id, req.valid.body);
  res.json({ label: label.toJSON() });
}

export async function remove(req, res) {
  await labelService.deleteLabel(req.userId, req.params.id);
  res.status(204).end();
}
