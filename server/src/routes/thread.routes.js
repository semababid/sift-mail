import { Router } from 'express';
import * as threads from '../controllers/thread.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validate } from '../middleware/validate.js';
import { listThreadsQuery, threadBatchBody } from '../schemas/thread.schema.js';

export const threadRouter = Router();

threadRouter.use(requireAuth);

threadRouter.get('/', validate({ query: listThreadsQuery }), threads.list);
threadRouter.get('/:id', threads.show);
threadRouter.post('/batch', validate({ body: threadBatchBody }), threads.batch);
