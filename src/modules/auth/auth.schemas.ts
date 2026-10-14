import { z } from 'zod';
import { publicUserSchema } from '../users/user.schemas.js';
import { newPasswordSchema, passwordContainsEmailName } from './password-policy.js';

export const emailField = z
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

/** A first or last name: trimmed, 1 to 50 characters. Shared by sign-up and PATCH /me. */
export const nameField = (label: string) =>
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

const linkToken = z.string({ error: 'This link is incomplete' }).min(20, 'This link is incomplete').max(200);

/** The token from a link we emailed: confirm an email address, or a new one. */
export const emailLinkSchema = z.object({ token: linkToken });

export const forgotPasswordSchema = z.object({ email: emailField });

export const resetPasswordSchema = z.object({ token: linkToken, password: newPasswordSchema });

/** A 6-digit code, typed from an SMS or an authenticator app. Spaces are ignored. */
export const codeField = z
  .string({ error: 'Enter the 6-digit code' })
  .transform((code) => code.replaceAll(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'));

export const mfaLoginSchema = z.object({
  challenge: z.string({ error: 'Sign in again' }).min(20).max(200),
  code: codeField,
});

export const codeSchema = z.object({ code: codeField });

/** Finishes adding an authenticator app: the first one turns two-factor sign-in on. */
export const mfaVerifySchema = z.object({
  code: codeField.meta({ description: 'From the app being added' }),
  name: z
    .string()
    .trim()
    .max(40, 'Use 40 characters or fewer')
    .optional()
    .meta({ description: 'What to call the app, e.g. "Work phone". A default is used when empty.' }),
  currentCode: codeField
    .optional()
    .meta({ description: 'Needed when two-factor sign-in is already on: a code from an app already set up' }),
});

export const phoneSchema = z.object({
  phone: z.string({ error: 'Enter your mobile number' }).trim().min(1, 'Enter your mobile number').max(30),
});

/** The website's page-load check: the signed-in user, or null for a visitor. */
export const sessionResponseSchema = z
  // A union rather than .nullable(): the OpenAPI generator writes a nullable reference as an
  // allOf that null can never match, and the website's generated types would come out wrong.
  .object({ user: z.union([publicUserSchema, z.null()]) })
  .meta({ id: 'SessionResponse' });

/** A staff password was right: now the code from their authenticator app. */
export const mfaChallengeResponseSchema = z
  .object({
    mfaRequired: z.literal(true),
    challenge: z
      .string()
      .meta({ description: 'Send back with the code to POST /auth/login/mfa (5 minutes)' }),
  })
  .meta({ id: 'MfaChallengeResponse' });

export const emailResponseSchema = z.object({ email: z.email() }).meta({ id: 'EmailResponse' });

export const phoneCodeResponseSchema = z
  .object({
    phone: z.string().meta({ description: 'The number in E.164, e.g. +64211234567' }),
    sent: z.boolean().meta({ description: 'false when it is already the verified number' }),
  })
  .meta({ id: 'PhoneCodeResponse' });

export const mfaSetupResponseSchema = z
  .object({
    secret: z.string().meta({ description: 'For typing into the app by hand' }),
    otpauthUrl: z.string(),
    qrCode: z.string().meta({ description: 'The otpauth URL as a PNG data: URL' }),
  })
  .meta({ id: 'MfaSetupResponse' });

export const mfaDeviceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    addedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().optional().meta({ description: 'The last time one of its codes was used' }),
  })
  .meta({ id: 'MfaDevice' });

/** A staff member's two-factor sign-in. Never includes the secrets. */
export const mfaStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    maxDevices: z.number().int().meta({ description: 'How many authenticator apps an account can have' }),
    devices: z.array(mfaDeviceSchema),
  })
  .meta({ id: 'MfaStatus' });

export const resendVerificationResponseSchema = z
  .object({
    sent: z.boolean().meta({ description: 'false when the email address is already confirmed' }),
  })
  .meta({ id: 'ResendVerificationResponse' });
