import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { threadRouter } from './thread.routes.js';
import { messageRouter, draftRouter } from './mail.routes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/threads', threadRouter);
apiRouter.use('/messages', messageRouter);
apiRouter.use('/drafts', draftRouter);
