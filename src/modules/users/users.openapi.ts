import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  codeSchema,
  emailResponseSchema,
  mfaSetupResponseSchema,
  mfaStatusResponseSchema,
  mfaVerifySchema,
} from '../auth/auth.schemas.js';
import { acceptAgreementsSchema, changeEmailSchema, changePasswordSchema } from './account.schemas.js';
import { favouritesResponseSchema, lastSearchSchema } from './saved.schemas.js';
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
    path: '/me/agreements',
    tags: ['Account'],
    summary: 'Accept the current version of legal documents',
    description:
      'Records the acceptance with its time and IP. The website asks for this when the user has pendingAgreements, after a new version of the Terms, Privacy Policy or an agreement is published.',
    security: signedIn,
    request: { body: jsonBody(acceptAgreementsSchema) },
    responses: { 200: jsonResponse('Accepted', userResponseSchema), ...errorResponses(400, 401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/mfa',
    tags: ['Account'],
    summary: 'Staff: two-factor sign-in and its authenticator apps',
    description:
      'Two-factor sign-in is optional for staff, and each staff member can have up to two authenticator apps (a backup for a lost phone). Never includes the secrets.',
    security: signedIn,
    responses: {
      200: jsonResponse('Whether it is on, and the apps', mfaStatusResponseSchema),
      ...errorResponses(401, 403),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/mfa/setup',
    tags: ['Account'],
    summary: 'Staff: start adding an authenticator app',
    description:
      'A new secret, shown once as a QR code, for the first app or a backup. Finish with POST /me/mfa/verify. 409 MFA_DEVICE_LIMIT when there are already two.',
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
    summary: 'Staff: finish adding an authenticator app',
    description:
      'The first code from the new app, which proves it has the secret. The first app turns two-factor sign-in on and signs out every other device (this one stays signed in). A second app also needs `currentCode`, from the app already set up. Emails the staff member either way.',
    security: signedIn,
    request: { body: jsonBody(mfaVerifySchema) },
    responses: {
      200: jsonResponse('The app is added', userResponseSchema),
      ...errorResponses(400, 401, 403, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/mfa/devices/{id}/remove',
    tags: ['Account'],
    summary: 'Staff: remove one of two authenticator apps',
    description:
      'Needs a code from either app. The last app can’t be removed (409 MFA_LAST_DEVICE): turn two-factor sign-in off instead. Emails the staff member.',
    security: signedIn,
    request: {
      params: z.object({ id: z.string().meta({ description: 'The authenticator app’s id' }) }),
      body: jsonBody(codeSchema),
    },
    responses: {
      200: jsonResponse('The apps left', mfaStatusResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/mfa/disable',
    tags: ['Account'],
    summary: 'Staff: turn off two-factor sign-in',
    description:
      'Needs a code from any of their authenticator apps, and removes them all. Sign-in then needs only the password. Emails the staff member.',
    security: signedIn,
    request: { body: jsonBody(codeSchema) },
    responses: {
      200: jsonResponse('Two-factor sign-in is off', userResponseSchema),
      ...errorResponses(400, 401, 403, 409, 429),
    },
  });

  const vehicleParam = z.object({ vehicleId: z.string().meta({ description: 'The car’s id' }) });

  registry.registerPath({
    method: 'get',
    path: '/me/favourites',
    tags: ['Account'],
    summary: 'Saved cars',
    description: 'The ids of the cars the user saved with the heart, most recent first.',
    security: signedIn,
    responses: { 200: jsonResponse('Saved cars', favouritesResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'put',
    path: '/me/favourites/{vehicleId}',
    tags: ['Account'],
    summary: 'Save a car',
    security: signedIn,
    request: { params: vehicleParam },
    responses: { 204: { description: 'Saved' }, ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'delete',
    path: '/me/favourites/{vehicleId}',
    tags: ['Account'],
    summary: 'Remove a saved car',
    security: signedIn,
    request: { params: vehicleParam },
    responses: { 204: { description: 'Removed' }, ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'put',
    path: '/me/last-search',
    tags: ['Account'],
    summary: 'Remember the last search',
    description: 'The place and dates Saved cars will price each saved car for.',
    security: signedIn,
    request: { body: jsonBody(lastSearchSchema) },
    responses: { 204: { description: 'Saved' }, ...errorResponses(400, 401) },
  });
}
