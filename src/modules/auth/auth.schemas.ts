import { z } from 'zod';
import { publicUserSchema } from '../users/user.schemas.js';

export const loginSchema = z.object({
  email: z
    .string({ error: 'Enter your email address' })
    .trim()
    .toLowerCase()
    .min(1, 'Enter your email address')
    .max(254, 'That email address is too long')
    .pipe(z.email({ error: 'Enter a valid email address' })),
  password: z
    .string({ error: 'Enter your password' })
    .min(1, 'Enter your password')
    .max(200, 'That password is too long'),
  // "admin" signs in to the staff portal and is refused for accounts without a staff role.
  portal: z.enum(['app', 'admin']).default('app'),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** The website's page-load check: the signed-in user, or null for a visitor. */
export const sessionResponseSchema = z
  .object({ user: publicUserSchema.nullable() })
  .meta({ id: 'SessionResponse' });
