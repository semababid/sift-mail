import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'not a valid id');

const addresses = z.array(z.email().max(254)).max(50);
const subject = z.string().trim().max(500);
const bodyText = z.string().max(200_000);

// Strict objects, so a bodyHtml field is refused instead of silently dropped.
// Bodies are plain text until HTML sanitising exists: accepting markup from one
// user and showing it to another is the same hole as rendering inbound mail.
export const sendBody = z
  .strictObject({
    to: addresses.default([]),
    cc: addresses.default([]),
    bcc: addresses.default([]),
    subject: subject.optional(),
    bodyText: bodyText.default(''),
    threadId: objectId.optional(),
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length > 0, {
    path: ['to'],
    message: 'add at least one recipient',
  });

// A draft can be saved before it has recipients, a subject or anything else.
export const createDraftBody = z.strictObject({
  to: addresses.optional(),
  cc: addresses.optional(),
  bcc: addresses.optional(),
  subject: subject.optional(),
  bodyText: bodyText.optional(),
  threadId: objectId.optional(),
});

// No threadId here: a draft stays in the thread it was started in.
export const updateDraftBody = z
  .strictObject({
    to: addresses.optional(),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    subject: subject.optional(),
    bodyText: bodyText.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

// The name and type of an uploaded file. The bytes are the request body.
export const uploadAttachmentQuery = z.object({
  filename: z.string().trim().min(1, 'name the file').max(255),
  type: z.string().max(255).optional(),
});
