import { Router } from 'express';
import * as auth from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validate } from '../middleware/validate.js';
import { authLimiter, refreshLimiter } from '../middleware/rate-limit.js';
import { registerBody, loginBody } from '../schemas/auth.schema.js';

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate({ body: registerBody }), auth.register);
authRouter.post('/login', authLimiter, validate({ body: loginBody }), auth.login);
authRouter.post('/refresh', refreshLimiter, auth.refresh);
authRouter.post('/logout', auth.logout);
authRouter.get('/me', requireAuth, auth.me);
