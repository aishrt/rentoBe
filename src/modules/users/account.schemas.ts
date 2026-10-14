import { z } from 'zod';
import { emailField, nameField } from '../auth/auth.schemas.js';
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

/**
 * PATCH /me: the person's name, as on their ID (plan §11). Send either or both; a name that's only spaces is
 * refused.
 */
export const updateMeSchema = z
  .object({
    firstName: nameField('first name').optional(),
    lastName: nameField('last name').optional(),
  })
  .refine((input) => input.firstName !== undefined || input.lastName !== undefined, {
    error: 'Send a first or last name to change',
  })
  .meta({ id: 'UpdateMeRequest' });
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const acceptAgreementsSchema = z
  .object({
    types: z
      .array(z.enum(AGREEMENT_TYPES, { error: 'Choose TERMS, PRIVACY, GUEST or HOST' }))
      .min(1, 'Choose at least one document')
      .max(AGREEMENT_TYPES.length),
  })
  .meta({ id: 'AcceptAgreementsRequest' });

/** PUT /me/photo: the profile photo just uploaded (plan §6.2: the other party sees it). */
export const profilePhotoSchema = z
  .object({
    key: z
      .string({ error: 'Upload a photo first' })
      .min(1, 'Upload a photo first')
      .max(300)
      .meta({ description: 'From POST /uploads/signature (purpose PROFILE_PHOTO), once the photo is sent' }),
  })
  .meta({ id: 'ProfilePhotoRequest' });
