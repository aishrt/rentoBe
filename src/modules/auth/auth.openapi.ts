import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { userResponseSchema } from '../users/user.schemas.js';
import {
  codeSchema,
  emailLinkSchema,
  emailResponseSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaChallengeResponseSchema,
  mfaLoginSchema,
  phoneCodeResponseSchema,
  phoneSchema,
  resendVerificationResponseSchema,
  resetPasswordSchema,
  sessionResponseSchema,
  signupSchema,
} from './auth.schemas.js';

/** The contract for auth.routes.ts (plan §2.3). */
export function registerAuthPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'post',
    path: '/auth/signup',
    tags: ['Auth'],
    summary: 'Create a Guest account',
    description:
      'Records acceptance of the current Terms and Privacy Policy, emails a link to confirm the address, and signs the new user in (sets the auth cookies). Passwords need 10+ characters, not a common one and not the email name. Rate-limited per IP.',
    request: { body: jsonBody(signupSchema) },
    responses: {
      201: jsonResponse('Account created and signed in', userResponseSchema),
      ...errorResponses(400, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/login',
    tags: ['Auth'],
    summary: 'Sign in with email and password',
    description:
      'Sets the httpOnly auth cookies. Staff with an authenticator app get `mfaRequired` and a challenge instead, for POST /auth/login/mfa. `portal: "admin"` refuses accounts without a staff role. Rate-limited per IP, and sign-in locks for 15 minutes after 5 wrong passwords.',
    request: { body: jsonBody(loginSchema) },
    responses: {
      200: jsonResponse(
        'Signed in, or the authenticator code is needed next',
        z.union([userResponseSchema, mfaChallengeResponseSchema]).meta({ id: 'LoginResponse' }),
      ),
      ...errorResponses(400, 401, 403, 423, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/login/mfa',
    tags: ['Auth'],
    summary: 'Finish a staff sign-in with the authenticator code',
    description:
      'The challenge from POST /auth/login and the 6-digit code from the app. Each code works once. After 5 wrong codes, or 5 minutes, the challenge expires (401 MFA_CHALLENGE_EXPIRED) and the password is needed again.',
    request: { body: jsonBody(mfaLoginSchema) },
    responses: {
      200: jsonResponse('Signed in', userResponseSchema),
      ...errorResponses(400, 401, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/session',
    tags: ['Auth'],
    summary: 'Who is signed in on this browser',
    description:
      "The website's check on page load. Always 200: `user` is null for a visitor. Renews an expired access token with the refresh cookie in the same call.",
    responses: { 200: jsonResponse('The signed-in user, or null', sessionResponseSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/refresh',
    tags: ['Auth'],
    summary: 'Renew the session',
    description: 'Swaps the refresh cookie for a new pair of cookies. Each refresh token works once.',
    responses: { 200: jsonResponse('Renewed', userResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/logout',
    tags: ['Auth'],
    summary: 'Sign out',
    description: 'Ends the session and clears the auth cookies.',
    responses: { 204: { description: 'Signed out' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/verify-email',
    tags: ['Auth'],
    summary: 'Confirm an email address',
    description:
      'The token from the link in the confirmation email. Each link works once and expires after 24 hours. Works signed out.',
    request: { body: jsonBody(emailLinkSchema) },
    responses: {
      200: jsonResponse('Confirmed', emailResponseSchema),
      ...errorResponses(400, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/verify-email/resend',
    tags: ['Auth'],
    summary: 'Send a new confirmation link',
    description: 'The previous link stops working. Up to 5 an hour per user.',
    security: signedIn,
    responses: {
      200: jsonResponse('Sent, or not needed', resendVerificationResponseSchema),
      ...errorResponses(401, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/forgot-password',
    tags: ['Auth'],
    summary: 'Email a link to choose a new password',
    description:
      'Sent only if the address has an account, but the answer is the same either way, so it can’t be used to find out who has one. The link works once and expires after 1 hour.',
    request: { body: jsonBody(forgotPasswordSchema) },
    responses: { 204: { description: 'Sent if the account exists' }, ...errorResponses(400, 429) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/reset-password',
    tags: ['Auth'],
    summary: 'Choose a new password from the emailed link',
    description:
      'Signs the account out on every device and emails "Password changed". The link also confirms the email address. It does not sign in.',
    request: { body: jsonBody(resetPasswordSchema) },
    responses: { 200: jsonResponse('Password changed', emailResponseSchema), ...errorResponses(400, 429) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/confirm-email-change',
    tags: ['Auth'],
    summary: 'Switch to a new email address',
    description:
      'The token from the link sent to the new address (POST /me/email). The old address is told about the change. Works signed out.',
    request: { body: jsonBody(emailLinkSchema) },
    responses: {
      200: jsonResponse('The account now uses this address', emailResponseSchema),
      ...errorResponses(400, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/phone/otp',
    tags: ['Auth'],
    summary: 'Text a verification code to a mobile number',
    description:
      'NZ numbers work without +64; overseas numbers need their country code. Landlines are refused. The number replaces the verified one only once its code is checked. 409 PHONE_TAKEN if another account verified it.',
    security: signedIn,
    request: { body: jsonBody(phoneSchema) },
    responses: {
      200: jsonResponse('Code sent', phoneCodeResponseSchema),
      ...errorResponses(400, 401, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/phone/verify',
    tags: ['Auth'],
    summary: 'Check the SMS code',
    security: signedIn,
    request: { body: jsonBody(codeSchema) },
    responses: {
      200: jsonResponse('The number is verified', userResponseSchema),
      ...errorResponses(400, 401, 409, 429),
    },
  });
}
