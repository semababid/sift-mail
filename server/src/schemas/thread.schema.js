import { z } from 'zod';
import { FOLDERS, INTENTS, LABEL_ACTIONS } from '../lib/constants.js';
import { objectId } from './mail.schema.js';

export const MAX_PAGE_SIZE = 100;

export const listThreadsQuery = z.object({
  folder: z.enum(FOLDERS).optional(),
  label: objectId.optional(),
  // One triage bucket of the folder or label.
  bucket: z.enum(INTENTS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).max(200).optional(),
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
  // Puts conversations in the bucket given, as the user's choice.
  'setBucket',
  // Takes the user's choice back, leaving the bucket the model gave.
  'resetBucket',
];

// How many conversations each bucket of a folder holds, for the tabs.
export const bucketCountsQuery = z.object({
  folder: z.enum(FOLDERS).default('inbox'),
});

// One endpoint for a single thread and a selection alike. The limit matches the
// largest page, since a selection is made from what is on screen.
export const threadBatchBody = z
  .strictObject({
    ids: z.array(objectId).min(1).max(MAX_PAGE_SIZE),
    action: z.enum([...THREAD_ACTIONS, ...LABEL_ACTIONS]),
    labelId: objectId.optional(),
    bucket: z.enum(INTENTS).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.action === 'setBucket' && !body.bucket) {
      ctx.addIssue({ code: 'custom', path: ['bucket'], message: 'setBucket needs a bucket' });
    }
    if (body.action !== 'setBucket' && body.bucket) {
      ctx.addIssue({ code: 'custom', path: ['bucket'], message: 'only setBucket takes a bucket' });
    }
    const needsLabel = LABEL_ACTIONS.includes(body.action);
    if (needsLabel && !body.labelId) {
      ctx.addIssue({ code: 'custom', path: ['labelId'], message: 'this action needs a labelId' });
    }
    if (!needsLabel && body.labelId) {
      ctx.addIssue({ code: 'custom', path: ['labelId'], message: 'only label actions take a labelId' });
    }
  });
