import { z } from 'zod';

const name = z.string().trim().min(1, 'a label needs a name').max(50);
const color = z.string().regex(/^#[0-9a-f]{6}$/i, 'use a hex colour like #0ea5e9');

export const createLabelBody = z.strictObject({
  name,
  color: color.optional(),
});

export const updateLabelBody = z
  .strictObject({
    name: name.optional(),
    color: color.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
