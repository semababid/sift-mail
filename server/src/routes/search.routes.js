import { Router } from 'express';
import { search } from '../controllers/search.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validate } from '../middleware/validate.js';
import { searchQuery } from '../schemas/search.schema.js';

export const searchRouter = Router();

searchRouter.use(requireAuth);
searchRouter.get('/', validate({ query: searchQuery }), search);
