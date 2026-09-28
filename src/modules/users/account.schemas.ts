import { z } from 'zod';
import { emailField } from '../auth/auth.schemas.js';
import { newPasswordSchema } from '../auth/password-policy.js';

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
