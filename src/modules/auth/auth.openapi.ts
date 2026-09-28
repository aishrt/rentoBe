import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { userResponseSchema } from '../users/user.schemas.js';
import {
  emailLinkSchema,
  loginSchema,
  resendVerificationResponseSchema,
  sessionResponseSchema,
  signupSchema,
  verifyEmailResponseSchema,
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
    path: '/auth/verify-email',
    tags: ['Auth'],
    summary: 'Confirm an email address',
    description:
      'The token from the link in the confirmation email. Each link works once and expires after 24 hours. Works signed out.',
    request: { body: jsonBody(emailLinkSchema) },
    responses: {
      200: jsonResponse('Confirmed', verifyEmailResponseSchema),
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
    path: '/auth/login',
    tags: ['Auth'],
    summary: 'Sign in with email and password',
    description:
      'Sets the httpOnly auth cookies. `portal: "admin"` refuses accounts without a staff role. Rate-limited per IP, and sign-in locks for 15 minutes after 5 wrong passwords.',
    request: { body: jsonBody(loginSchema) },
    responses: {
      200: jsonResponse('Signed in', userResponseSchema),
      ...errorResponses(400, 401, 403, 423, 429),
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
}
