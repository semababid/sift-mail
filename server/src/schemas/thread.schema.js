import { z } from 'zod';
import { FOLDERS, LABEL_ACTIONS } from '../lib/constants.js';
import { objectId } from './mail.schema.js';

export const MAX_PAGE_SIZE = 100;

export const listThreadsQuery = z.object({
  folder: z.enum(FOLDERS).optional(),
  label: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
});

export const THREAD_ACTIONS = [
  'archive',
  'moveToInbox',
  'trash',
  'restore',
  'markRead',
  'markUnread',
  'star',
  'unstar',
];

// One endpoint for a single thread and a selection alike. The limit matches the
// largest page, since a selection is made from what is on screen.
export const threadBatchBody = z
  .strictObject({
    ids: z.array(objectId).min(1).max(MAX_PAGE_SIZE),
    action: z.enum([...THREAD_ACTIONS, ...LABEL_ACTIONS]),
    labelId: objectId.optional(),
  })
  .superRefine((body, ctx) => {
    const needsLabel = LABEL_ACTIONS.includes(body.action);
    if (needsLabel && !body.labelId) {
      ctx.addIssue({ code: 'custom', path: ['labelId'], message: 'this action needs a labelId' });
    }
    if (!needsLabel && body.labelId) {
      ctx.addIssue({ code: 'custom', path: ['labelId'], message: 'only label actions take a labelId' });
    }
  });
