import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { threadRouter } from './thread.routes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/threads', threadRouter);
