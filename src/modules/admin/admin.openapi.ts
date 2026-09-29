import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonResponse, signedIn } from '../../openapi/shared.js';
import { testPaymentSchema, testPaymentStatusSchema } from '../payments/payments.schemas.js';
import { adminOverviewSchema } from './admin.schemas.js';

/** The contract for admin.routes.ts (plan §2.3). Every admin route needs an active staff account. */
export function registerAdminPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/admin/overview',
    tags: ['Admin'],
    summary: 'KPI figures for the staff portal',
    description: 'Admin and Support only.',
    security: signedIn,
    responses: {
      200: jsonResponse('The overview figures', adminOverviewSchema),
      ...errorResponses(401, 403),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/staff/{id}/mfa/reset',
    tags: ['Admin'],
    summary: "Reset a staff member's lost authenticator apps",
    description:
      'Admin only, and not for your own account. Removes all their authenticator apps and signs them out everywhere; they sign in with only their password and can set up a new app in Settings. Written to the audit log.',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The staff member’s user id' }) }) },
    responses: { 204: { description: 'Reset' }, ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/payments/test',
    tags: ['Admin'],
    summary: 'Start a NZ$1 test payment in the Stripe sandbox',
    description:
      'Admin only. Checks the Stripe keys, Apple Pay, Google Pay and the webhook before the booking flow exists. Refused (409 LIVE_MODE) with live keys, and 503 until the keys are set.',
    security: signedIn,
    responses: {
      201: jsonResponse('The payment, ready for Stripe.js to confirm', testPaymentSchema),
      ...errorResponses(401, 403, 409, 503),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/payments/test/{id}',
    tags: ['Admin'],
    summary: 'How a test payment went',
    description:
      'Admin only. Its status, how it was paid (card, Apple Pay, Google Pay) and whether its webhook arrived.',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The PaymentIntent id (pi_…)' }) }) },
    responses: {
      200: jsonResponse('The test payment', testPaymentStatusSchema),
      ...errorResponses(401, 403, 404, 503),
    },
  });
}
