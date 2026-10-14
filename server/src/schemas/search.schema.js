import { z } from 'zod';

export const MAX_SEARCH_RESULTS = 50;

// A repeated ?q= arrives as an array and fails the string check, rather than
// silently searching for only one of them.
export const searchQuery = z.object({
  q: z.string().trim().min(1, 'type something to search for').max(200),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_RESULTS).default(20),
  // ?debug=1 adds each result's rank and score in both searches.
  debug: z.stringbool().default(false),
});
