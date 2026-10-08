import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  earningsResponseSchema,
  hostPayoutsResponseSchema,
  statementQuerySchema,
  linkResponseSchema,
  payLinkSchema,
  payLinkSessionSchema,
  payoutAccountSchema,
} from './payouts.schemas.js';

/** The contract for payouts.routes.ts (plan §2.3). */
export function registerPayoutPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/host/payouts',
    tags: ['Hosting'],
    summary: 'The Host’s payout setup and payouts',
    description:
      'Upcoming, held and paid payouts, newest first, with the commission and its GST, deductions, and when a paid one should reach the bank.',
    security: signedIn,
    responses: { 200: jsonResponse('Payouts', hostPayoutsResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/host/earnings',
    tags: ['Hosting'],
    summary: 'The earnings dashboard',
    description:
      'Earnings count on the trip’s start date in NZ time, weeks run Monday to Sunday, and amounts are net of Host-funded refunds and Host cancellation fees.',
    security: signedIn,
    responses: { 200: jsonResponse('Earnings', earningsResponseSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'get',
    path: '/host/earnings/statement',
    tags: ['Hosting'],
    summary: 'A GST-ready earnings statement (CSV)',
    description:
      'By month or NZ tax year (1 April–31 March): rental, delivery, extra charges, commission, deductions and GST on separate columns.',
    security: signedIn,
    request: { query: statementQuerySchema },
    responses: {
      200: { description: 'The statement', content: { 'text/csv': { schema: z.string() } } },
      ...errorResponses(400, 401, 404),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/connect/onboarding-link',
    tags: ['Hosting'],
    summary: 'Start or continue payout setup with Stripe',
    description:
      'Makes the Host’s Stripe Connect Express account the first time. Send the Host to the link; Stripe returns them to /host/earnings.',
    security: signedIn,
    responses: {
      200: jsonResponse('Stripe’s setup page', linkResponseSchema),
      ...errorResponses(401, 404, 409, 503),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/connect/sync',
    tags: ['Hosting'],
    summary: 'Read the payout account from Stripe',
    description:
      'For when the Host comes back from Stripe. Releases payouts held for the setup once it’s done.',
    security: signedIn,
    responses: {
      200: jsonResponse(
        'The payout account',
        z.object({ account: payoutAccountSchema }).meta({ id: 'PayoutAccountResponse' }),
      ),
      ...errorResponses(401, 404, 409, 503),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/connect/dashboard-link',
    tags: ['Hosting'],
    summary: 'Open Stripe’s Express dashboard',
    description: 'Where the Host changes their bank account and sees Stripe’s payouts to it.',
    security: signedIn,
    responses: {
      200: jsonResponse('The dashboard', linkResponseSchema),
      ...errorResponses(401, 404, 409, 503),
    },
  });

  const params = z.object({ id: z.string() });
  const payLinkResponse = z.object({ payment: payLinkSchema }).meta({ id: 'PayLinkResponse' });
  registry.registerPath({
    method: 'get',
    path: '/payments/{id}',
    tags: ['Payments'],
    summary: 'An extra charge to pay',
    description:
      'For the booking’s Guest: the link in the email when a charge to their saved card didn’t go through.',
    security: signedIn,
    request: { params },
    responses: { 200: jsonResponse('The charge', payLinkResponse), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/payments/{id}/pay',
    tags: ['Payments'],
    summary: 'Pay an extra charge with another card or a wallet',
    description: 'Returns what Stripe.js needs; then POST /payments/{id}/sync.',
    security: signedIn,
    request: { params },
    responses: {
      200: jsonResponse('For Stripe.js', payLinkSessionSchema),
      ...errorResponses(401, 404, 409, 503),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/payments/{id}/sync',
    tags: ['Payments'],
    summary: 'Apply the payment straight after Stripe.js confirms it',
    security: signedIn,
    request: { params },
    responses: { 200: jsonResponse('The charge', payLinkResponse), ...errorResponses(401, 404, 503) },
  });
}
