import { z } from 'zod';

export const registerBody = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'password must be at least 10 characters').max(200),
  name: z.string().trim().min(1).max(80),
});

export const loginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1),
});
