import { searchThreads } from '../services/search.service.js';

export async function search(req, res) {
  const { q, limit } = req.valid.query;
  res.json({ results: await searchThreads(req.userId, q, { limit }) });
}
