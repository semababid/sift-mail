import { Router } from 'express';
import * as labels from '../controllers/label.controller.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validate } from '../middleware/validate.js';
import { createLabelBody, updateLabelBody } from '../schemas/label.schema.js';

export const labelRouter = Router();

labelRouter.use(requireAuth);

labelRouter.get('/', labels.list);
labelRouter.post('/', validate({ body: createLabelBody }), labels.create);
labelRouter.patch('/:id', validate({ body: updateLabelBody }), labels.update);
labelRouter.delete('/:id', labels.remove);
