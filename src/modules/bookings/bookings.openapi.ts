import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { checkoutReadinessSchema, driverLicenceInputSchema } from '../users/driver-licence.schemas.js';
import {
  BOOKING_GROUPS,
  adminCancelSchema,
  bookingResponseSchema,
  bookingsResponseSchema,
  cancelBookingSchema,
  cancellationPreviewSchema,
  createBookingSchema,
  declineBookingSchema,
  identityReviewResponseSchema,
  identityReviewSchema,
  paymentSessionSchema,
  preparePaymentSchema,
  receiptResponseSchema,
} from './bookings.schemas.js';

const idParam = z.object({
  id: z.string().meta({ description: 'The booking’s reference (RV-7K2Q9M) or id' }),
});

/** The contract for the booking flow (plan §2.3, §11). */
export function registerBookingPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/me/checkout',
    tags: ['Bookings'],
    summary: 'What checkout’s verification step still needs',
    description:
      'Mobile, licence details and the eligibility rules in settings. With `end`, the licence is checked against that trip end.',
    security: signedIn,
    request: { query: z.object({ end: z.string().optional() }) },
    responses: { 200: jsonResponse('Readiness', checkoutReadinessSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'put',
    path: '/me/driver-licence',
    tags: ['Bookings'],
    summary: 'Save driver licence details',
    description:
      'The number is encrypted, and a keyed hash finds the same licence on another account (a risk flag, not an error). Support staff check licences until the identity check arrives.',
    security: signedIn,
    request: { body: jsonBody(driverLicenceInputSchema) },
    responses: { 200: jsonResponse('Readiness', checkoutReadinessSchema), ...errorResponses(400, 401) },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings',
    tags: ['Bookings'],
    summary: 'Book a car',
    description:
      'Checks the Guest (409 VERIFICATION_REQUIRED, with the missing items in `fields.verification`) and the trip (as the quote does; 409 DATES_UNAVAILABLE), then creates a PAYMENT_PENDING booking and holds the dates for 30 minutes. The same request again returns the same booking.',
    security: signedIn,
    request: { body: jsonBody(createBookingSchema) },
    responses: {
      201: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409, 429),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/bookings',
    tags: ['Bookings'],
    summary: 'My trips, or my bookings as a Host',
    description:
      'Groups (plan §8.2): upcoming (confirmed, and requests), current, completed, cancelled (cancelled, declined, expired), and requests (Hosts: waiting for an answer). Unpaid checkouts are left out.',
    security: signedIn,
    request: {
      query: z.object({
        role: z.enum(['guest', 'host']).optional(),
        group: z.enum(BOOKING_GROUPS).optional(),
      }),
    },
    responses: { 200: jsonResponse('Bookings', bookingsResponseSchema), ...errorResponses(400, 401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/bookings/{id}',
    tags: ['Bookings'],
    summary: 'One booking, as the Guest, the Host or staff see it',
    security: signedIn,
    request: { params: idParam },
    responses: { 200: jsonResponse('The booking', bookingResponseSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/payment',
    tags: ['Bookings'],
    summary: 'Start paying',
    description:
      'Records the Guest Agreement and returns the PaymentIntent’s client secret (charged now for Instant Book, authorised only for a request) and a customer session for saved cards. 409 HOLD_EXPIRED after 30 minutes.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(preparePaymentSchema) },
    responses: {
      200: jsonResponse('The payment session', paymentSessionSchema),
      ...errorResponses(400, 401, 403, 404, 409, 503),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/payment/sync',
    tags: ['Bookings'],
    summary: 'Apply the payment result now',
    description: 'Called after Stripe.js confirms, so the booking updates without waiting for the webhook.',
    security: signedIn,
    request: { params: idParam },
    responses: {
      200: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(401, 403, 404, 503),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/bookings/{id}/receipt',
    tags: ['Bookings'],
    summary: 'The GST receipt',
    description:
      'For the Guest (and staff) once the booking is paid (plan §8.1, item 18): every line, the GST included, how it was paid and any refunds. 409 NO_RECEIPT before payment; 403 for the Host.',
    security: signedIn,
    request: { params: idParam },
    responses: {
      200: jsonResponse('The receipt', receiptResponseSchema),
      ...errorResponses(401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/bookings/{id}/receipt.pdf',
    tags: ['Bookings'],
    summary: 'The GST receipt as a PDF',
    description: 'The same receipt as an A4 PDF to download.',
    security: signedIn,
    request: { params: idParam },
    responses: {
      200: {
        description: 'The PDF, as an attachment',
        content: { 'application/pdf': { schema: z.string().meta({ format: 'binary' }) } },
      },
      ...errorResponses(401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/bookings/{id}/cancellation-preview',
    tags: ['Bookings'],
    summary: 'What cancelling would refund and cost',
    description:
      'Shown before the user confirms (plan §5): the refund, the fee under the booking’s tier, and a sentence to show.',
    security: signedIn,
    request: { params: idParam },
    responses: { 200: jsonResponse('The preview', cancellationPreviewSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/cancel',
    tags: ['Bookings'],
    summary: 'Cancel a booking, or withdraw a request',
    description:
      'The Guest: an unpaid checkout is released, a request withdrawn (nothing charged), a confirmed booking refunded under its tier. The Host: a confirmed booking is refunded in full and any Host cancellation fee applies; a request is declined instead (409 USE_DECLINE).',
    security: signedIn,
    request: { params: idParam, body: jsonBody(cancelBookingSchema) },
    responses: {
      200: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/accept',
    tags: ['Bookings'],
    summary: 'Host: accept a request',
    description:
      'Captures the authorised payment and confirms the booking. 409 when it has expired or was answered.',
    security: signedIn,
    request: { params: idParam },
    responses: {
      200: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/decline',
    tags: ['Bookings'],
    summary: 'Host: decline a request',
    description: 'Releases the Guest’s authorisation. No fee.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(declineBookingSchema) },
    responses: {
      200: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/bookings/{id}/cancel',
    tags: ['Admin'],
    summary: 'Staff: cancel for a no-show, or as a platform cancellation',
    description:
      'Admins, and support staff with the REFUNDS permission. A Guest no-show is a Guest cancellation at the start time; a Host no-show a Host cancellation; a platform cancellation a full refund.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(adminCancelSchema) },
    responses: {
      200: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/users/{id}/identity-review',
    tags: ['Admin'],
    summary: 'Staff: decide an identity check that needed a manual review',
    description:
      'Approving confirms the Guest’s bookings that waited for the check (capturing their card authorisations), except requests their Host still has to accept. Rejecting ends those bookings and releases the authorisations (plan §8.2).',
    security: signedIn,
    request: {
      params: z.object({ id: z.string().meta({ description: 'The user’s id' }) }),
      body: jsonBody(identityReviewSchema),
    },
    responses: {
      200: jsonResponse('The decision, and what it did to their bookings', identityReviewResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
