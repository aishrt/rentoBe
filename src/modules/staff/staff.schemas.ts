import { z } from 'zod';
import { emailField } from '../auth/auth.schemas.js';
import { newPasswordSchema } from '../auth/password-policy.js';
import { USER_STATUSES } from '../users/user.model.js';

const nameField = (label: string) =>
  z
    .string({ error: `Enter their ${label}` })
    .trim()
    .min(1, `Enter their ${label}`)
    .max(50, `That ${label} is too long`);

/** The admin invites someone to the support team. */
export const staffInviteInputSchema = z.object({
  email: emailField,
  firstName: nameField('first name'),
  lastName: nameField('last name'),
});

export type StaffInviteInput = z.infer<typeof staffInviteInputSchema>;

const inviteToken = z
  .string({ error: 'This link is incomplete' })
  .min(20, 'This link is incomplete')
  .max(200);

/** The token from the invitation email. */
export const staffInviteTokenSchema = z.object({ token: inviteToken });

export const acceptStaffInviteSchema = z.object({ token: inviteToken, password: newPasswordSchema });

export const staffInviteSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    firstName: z.string(),
    lastName: z.string(),
    invitedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().meta({ description: 'The link stops working after this' }),
  })
  .meta({ id: 'StaffInvite' });

export const staffMemberSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    firstName: z.string(),
    lastName: z.string(),
    role: z.enum(['ADMIN', 'SUPPORT']),
    status: z.enum(USER_STATUSES),
    mfaEnabled: z.boolean(),
    lastLoginAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'StaffMember' });

export const staffInviteResponseSchema = z
  .object({ invite: staffInviteSchema })
  .meta({ id: 'StaffInviteResponse' });

/** The admin, the support team, and the invitations not yet accepted. */
export const staffListSchema = z
  .object({ staff: z.array(staffMemberSchema), invites: z.array(staffInviteSchema) })
  .meta({ id: 'StaffList' });

/** What the invitation page shows before the password is chosen. */
export const staffInviteDetailsSchema = z
  .object({
    email: z.email(),
    firstName: z.string(),
    existingAccount: z.boolean().meta({
      description: 'The email already has a Rento Vroom account; the new password replaces its old one',
    }),
  })
  .meta({ id: 'StaffInviteDetails' });

export type StaffInviteView = z.infer<typeof staffInviteSchema>;
export type StaffMember = z.infer<typeof staffMemberSchema>;
export type StaffList = z.infer<typeof staffListSchema>;
export type StaffInviteDetails = z.infer<typeof staffInviteDetailsSchema>;
