import { z } from 'zod';
import { publicUserSchema } from '../users/user.schemas.js';
import { newPasswordSchema, passwordContainsEmailName } from './password-policy.js';

const emailField = z
  .string({ error: 'Enter your email address' })
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address')
  .max(254, 'That email address is too long')
  .pipe(z.email({ error: 'Enter a valid email address' }));

export const loginSchema = z.object({
  email: emailField,
  password: z
    .string({ error: 'Enter your password' })
    .min(1, 'Enter your password')
    .max(200, 'That password is too long'),
  // "admin" signs in to the staff portal and is refused for accounts without a staff role.
  portal: z.enum(['app', 'admin']).default('app'),
});

export type LoginInput = z.infer<typeof loginSchema>;

const nameField = (label: string) =>
  z
    .string({ error: `Enter your ${label}` })
    .trim()
    .min(1, `Enter your ${label}`)
    .max(50, `That ${label} is too long`);

export const signupSchema = z
  .object({
    firstName: nameField('first name'),
    lastName: nameField('last name'),
    email: emailField,
    password: newPasswordSchema,
    // Terms and Conditions and the Privacy Policy, accepted at sign-up (plan §6.1).
    acceptTerms: z.literal(true, {
      error: 'Please accept the Terms and Conditions and the Privacy Policy',
    }),
  })
  .superRefine((input, context) => {
    if (passwordContainsEmailName(input.password, input.email)) {
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: "Don't use your email address in your password",
      });
    }
  });

export type SignupInput = z.infer<typeof signupSchema>;

/** The token from a link we emailed: confirm an email address, or reset a password. */
export const emailLinkSchema = z.object({
  token: z.string({ error: 'This link is incomplete' }).min(20, 'This link is incomplete').max(200),
});

/** The website's page-load check: the signed-in user, or null for a visitor. */
export const sessionResponseSchema = z
  // A union rather than .nullable(): the OpenAPI generator writes a nullable reference as an
  // allOf that null can never match, and the website's generated types would come out wrong.
  .object({ user: z.union([publicUserSchema, z.null()]) })
  .meta({ id: 'SessionResponse' });

export const verifyEmailResponseSchema = z.object({ email: z.email() }).meta({ id: 'VerifyEmailResponse' });

export const resendVerificationResponseSchema = z
  .object({
    sent: z.boolean().meta({ description: 'false when the email address is already confirmed' }),
  })
  .meta({ id: 'ResendVerificationResponse' });
