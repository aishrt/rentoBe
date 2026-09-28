import { z } from 'zod';
import { emailField } from '../auth/auth.schemas.js';
import { newPasswordSchema } from '../auth/password-policy.js';
import { AGREEMENT_TYPES } from './user.model.js';

const currentPassword = z
  .string({ error: 'Enter your current password' })
  .min(1, 'Enter your current password')
  .max(200);

export const changePasswordSchema = z.object({
  currentPassword,
  newPassword: newPasswordSchema,
});

export const changeEmailSchema = z.object({
  newEmail: emailField,
  currentPassword,
});

export const acceptAgreementsSchema = z
  .object({
    types: z
      .array(z.enum(AGREEMENT_TYPES, { error: 'Choose TERMS, PRIVACY, GUEST or HOST' }))
      .min(1, 'Choose at least one document')
      .max(AGREEMENT_TYPES.length),
  })
  .meta({ id: 'AcceptAgreementsRequest' });
