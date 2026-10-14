import { searchThreads } from '../services/search.service.js';

export async function search(req, res) {
  const { q, limit, debug } = req.valid.query;
  res.json(await searchThreads(req.userId, q, { limit, debug }));
}
