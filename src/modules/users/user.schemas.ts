import { z } from 'zod';
import { AGREEMENT_TYPES, HOST_STATUSES, ROLES } from './user.model.js';

/** The user fields the API returns about the signed-in user. Never includes secrets. */
export const publicUserSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    firstName: z.string(),
    lastName: z.string(),
    roles: z.array(z.enum(ROLES)),
    emailVerified: z.boolean(),
    phone: z.string().optional().meta({ description: 'Verified mobile number, E.164 (+64211234567)' }),
    phoneVerified: z.boolean(),
    mfaEnabled: z.boolean().meta({ description: 'Staff: whether two-factor sign-in is on' }),
    hostStatus: z
      .enum(HOST_STATUSES)
      .nullable()
      .meta({ description: 'Where their Host application is; null if they never applied' }),
    pendingAgreements: z.array(z.enum(AGREEMENT_TYPES)).meta({
      description:
        'Legal documents with a new version the user must accept before carrying on (POST /me/agreements). Usually empty.',
    }),
  })
  .meta({ id: 'PublicUser' });

export type PublicUser = z.infer<typeof publicUserSchema>;

export const userResponseSchema = z.object({ user: publicUserSchema }).meta({ id: 'UserResponse' });
