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
import {
  cardSetupResponseSchema,
  paymentHistoryResponseSchema,
  savedCardsResponseSchema,
} from '../payments/payments.schemas.js';
import {
  accountClosureSchema,
  privacyRequestResponseSchema,
  privacyRequestSchema,
} from './privacy.schemas.js';
import { favouritesResponseSchema, lastSearchSchema, savedCarsResponseSchema } from './saved.schemas.js';
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

  registry.registerPath({
    method: 'get',
    path: '/me/saved-cars',
    tags: ['Account'],
    summary: 'The Saved cars page',
    description:
      'Each saved car as a card, with its estimated total for the last searched dates when it can be booked for them (spec §8, §28: comparing cars). A car its Host has taken down shows `listed: false`.',
    security: signedIn,
    responses: { 200: jsonResponse('Saved cars', savedCarsResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/payment-methods',
    tags: ['Account'],
    summary: 'Saved cards',
    description:
      'The cards saved to the Guest’s Stripe customer, from checkout or added here (plan §8.1, item 7). Empty until the first one.',
    security: signedIn,
    responses: {
      200: jsonResponse('Saved cards', savedCardsResponseSchema),
      ...errorResponses(401, 503),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/payment-methods/setup',
    tags: ['Account'],
    summary: 'Start saving a card',
    description:
      'A Stripe SetupIntent for the Payment Element to save one card for checkout and post-trip charges. Card details go straight to Stripe.',
    security: signedIn,
    responses: {
      200: jsonResponse('Ready for the Payment Element', cardSetupResponseSchema),
      ...errorResponses(401, 429, 503),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/me/payment-methods/{id}',
    tags: ['Account'],
    summary: 'Remove a saved card',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The card’s id (pm_…)' }) }) },
    responses: { 204: { description: 'Removed' }, ...errorResponses(401, 404, 503) },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/payments',
    tags: ['Account'],
    summary: 'Payment history',
    description:
      'What the Guest has paid, newest first, with refunds and whether each has a receipt (plan §8.1, item 7). Attempts that never charged anything are left out.',
    security: signedIn,
    responses: {
      200: jsonResponse('Payments', paymentHistoryResponseSchema),
      ...errorResponses(401),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/account-closure',
    tags: ['Account'],
    summary: 'Whether the account can be closed now',
    description:
      'Closing is refused while a trip or booking is requested, booked or under way, an incident is open, an extra charge is unpaid or a payout is due (plan §8.2).',
    security: signedIn,
    responses: { 200: jsonResponse('Whether, and why not', accountClosureSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'post',
    path: '/me/privacy-requests',
    tags: ['Account'],
    summary: 'Ask for a copy or correction of personal information, or to close the account',
    description:
      'Opens a PRIVACY support ticket for staff to carry out, and emails its reference (NZ Privacy Act 2020, plan §14). The same request while one is open returns that one. Closing the account answers 409 CLOSURE_BLOCKED while GET /me/account-closure lists blockers.',
    security: signedIn,
    request: { body: jsonBody(privacyRequestSchema) },
    responses: {
      201: jsonResponse('The ticket', privacyRequestResponseSchema),
      ...errorResponses(400, 401, 409, 429),
    },
  });
}
