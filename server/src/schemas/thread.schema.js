import { z } from 'zod';
import { FOLDERS } from '../lib/constants.js';

export const MAX_PAGE_SIZE = 100;

export const listThreadsQuery = z.object({
  folder: z.enum(FOLDERS).default('inbox'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
});
