import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { codeSchema, emailResponseSchema, mfaSetupResponseSchema } from '../auth/auth.schemas.js';
import { changeEmailSchema, changePasswordSchema } from './account.schemas.js';
import { userResponseSchema } from './user.schemas.js';

/** The contract for users.routes.ts (plan §2.3). */
export function registerUserPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/me',
    tags: ['Account'],
    summary: 'The signed-in user',
    security: signedIn,
    responses: { 200: jsonResponse('The signed-in user', userResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/password',
    tags: ['Account'],
    summary: 'Change the password',
    description:
      'Needs the current password. Signs out every other device (this one stays signed in) and emails "Password changed".',
    security: signedIn,
    request: { body: jsonBody(changePasswordSchema) },
    responses: { 204: { description: 'Changed' }, ...errorResponses(400, 401, 429) },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/email',
    tags: ['Account'],
    summary: 'Change the email address',
    description:
      'Needs the current password. Emails a link to the new address; the current one keeps working until it is opened (POST /auth/confirm-email-change).',
    security: signedIn,
    request: { body: jsonBody(changeEmailSchema) },
    responses: {
      200: jsonResponse('Link sent to the new address', emailResponseSchema),
      ...errorResponses(400, 401, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/mfa/setup',
    tags: ['Account'],
    summary: 'Staff: start setting up the authenticator app',
    description:
      'A new secret, shown once as a QR code. Required before the staff portal opens (403 MFA_SETUP_REQUIRED). Finish with POST /me/mfa/verify.',
    security: signedIn,
    responses: {
      200: jsonResponse('Scan this with the app', mfaSetupResponseSchema),
      ...errorResponses(401, 403, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/mfa/verify',
    tags: ['Account'],
    summary: 'Staff: finish setting up the authenticator app',
    description: 'The first code from the app, which proves it has the secret.',
    security: signedIn,
    request: { body: jsonBody(codeSchema) },
    responses: {
      200: jsonResponse('Two-factor sign-in is on', userResponseSchema),
      ...errorResponses(400, 401, 403, 409, 429),
    },
  });
}
