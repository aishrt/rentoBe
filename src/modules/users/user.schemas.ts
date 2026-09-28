import { z } from 'zod';
import { ROLES } from './user.model.js';

/** The user fields the API returns about the signed-in user. Never includes secrets. */
export const publicUserSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    firstName: z.string(),
    lastName: z.string(),
    roles: z.array(z.enum(ROLES)),
    emailVerified: z.boolean(),
  })
  .meta({ id: 'PublicUser' });

export type PublicUser = z.infer<typeof publicUserSchema>;

export const userResponseSchema = z.object({ user: publicUserSchema }).meta({ id: 'UserResponse' });
