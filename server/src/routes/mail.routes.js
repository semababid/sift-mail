import { Router } from 'express';
import * as mail from '../controllers/mail.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validate } from '../middleware/validate.js';
import { sendBody, createDraftBody, updateDraftBody, uploadAttachmentQuery } from '../schemas/mail.schema.js';

export const messageRouter = Router();
messageRouter.use(requireAuth);
messageRouter.post('/', validate({ body: sendBody }), mail.send);
messageRouter.get('/:id/attachments/:attachmentId', mail.downloadAttachment);

export const draftRouter = Router();
draftRouter.use(requireAuth);
draftRouter.post('/', validate({ body: createDraftBody }), mail.createDraft);
draftRouter.patch('/:id', validate({ body: updateDraftBody }), mail.updateDraft);
draftRouter.delete('/:id', mail.deleteDraft);
draftRouter.post('/:id/send', mail.sendDraft);
draftRouter.post('/:id/attachments', validate({ query: uploadAttachmentQuery }), mail.uploadAttachment);
draftRouter.delete('/:id/attachments/:attachmentId', mail.removeAttachment);
