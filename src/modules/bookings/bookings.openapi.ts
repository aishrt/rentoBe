import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { adminBookingDetailSchema } from '../admin/admin-ops.schemas.js';
import { cancelExtraChargeSchema } from '../payments/payments.schemas.js';
import { checkoutReadinessSchema, driverLicenceInputSchema } from '../users/driver-licence.schemas.js';
import {
  BOOKING_GROUPS,
  adminCancellationPreviewQuerySchema,
  adminCancellationPreviewSchema,
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
      'Mobile, licence details and the eligibility rules in settings. With `end`, the licence is checked against that trip end; with `start`, age and years licensed count to that trip start (otherwise to today).',
    security: signedIn,
    request: { query: z.object({ end: z.string().optional(), start: z.string().optional() }) },
    responses: { 200: jsonResponse('Readiness', checkoutReadinessSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'put',
    path: '/me/driver-licence',
    tags: ['Bookings'],
    summary: 'Save driver licence details',
    description:
      'The number is encrypted, and a keyed hash finds the same licence on another account (a risk flag, not an error). The identity check confirms it when the person uses their licence as the ID; otherwise support staff check it. The person’s upcoming bookings are checked against the new details: a request that no longer qualifies waits for support, and support hear of a confirmed trip that no longer does.',
    security: signedIn,
    request: { body: jsonBody(driverLicenceInputSchema) },
    responses: { 200: jsonResponse('Readiness', checkoutReadinessSchema), ...errorResponses(400, 401) },
  });

  const identitySchema = z
    .object({
      status: z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED']).meta({
        description: 'NONE until it passes; PENDING while support reviews it by hand',
      }),
      sessionStatus: z
        .string()
        .optional()
        .meta({ description: 'Stripe’s: requires_input, processing, verified or canceled' }),
      lastError: z.string().optional().meta({ description: 'Why the last attempt didn’t pass' }),
      documentType: z.string().optional(),
      verifiedAt: z.iso.datetime().optional(),
    })
    .meta({ id: 'IdentityStatus' });

  registry.registerPath({
    method: 'post',
    path: '/me/verification',
    tags: ['Bookings'],
    summary: 'Start the identity check (Stripe Identity)',
    description:
      'A photo of an ID (the driver licence if possible) and a matching selfie, on Stripe’s page. Stripe brings the person back to `returnTo`, a path on the website. A check under way carries on: one waiting for the person reopens; 409 IDENTITY_PROCESSING while Stripe is checking one, ALREADY_VERIFIED or IN_REVIEW once its result is applied. A new check starts only when the last was cancelled.',
    security: signedIn,
    request: {
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.object({ returnTo: z.string().optional() }).meta({ id: 'IdentityCheckRequest' }),
          },
        },
      },
    },
    responses: {
      200: jsonResponse(
        'Stripe’s identity page',
        z.object({ url: z.string() }).meta({ id: 'IdentityCheckLink' }),
      ),
      ...errorResponses(401, 409, 429, 503),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/verification',
    tags: ['Bookings'],
    summary: 'Where the identity check stands',
    description: 'Read again from Stripe while it’s under way, so checkout can wait for the result.',
    security: signedIn,
    responses: {
      200: jsonResponse('The check', z.object({ identity: identitySchema }).meta({ id: 'IdentityResponse' })),
      ...errorResponses(401),
    },
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
      'Groups (plan §8.2): upcoming (confirmed, and requests), current, completed, cancelled (cancelled, declined, expired), and requests (Hosts: waiting for an answer). Unpaid checkouts are left out. A page at a time: nextPage is set when there are more.',
    security: signedIn,
    request: {
      query: z.object({
        role: z.enum(['guest', 'host']).optional(),
        group: z.enum(BOOKING_GROUPS).optional(),
        page: z.number().int().min(1).optional(),
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
      'The Guest: an unpaid checkout is released, a request withdrawn (nothing charged), a confirmed booking refunded under its tier; after the pick-up time it counts as not turning up, so the tier applies as at the start time. The Host: a confirmed booking is refunded in full and any Host cancellation fee applies, until the start time (then 409 TRIP_STARTED: support handles it); a request is declined instead (409 USE_DECLINE). With expectedRefundCents, a refund now lower than the preview showed cancels nothing (409 REFUND_CHANGED). A booking whose payment is in a card dispute (a chargeback) can be cancelled only by support (409 PAYMENT_DISPUTED; the preview says so).',
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
      'Captures the authorised payment and confirms the booking. While the Guest’s identity check or licence waits for support (checked again here), the acceptance is recorded and the booking is confirmed once support approves it. 409 when it has expired or was answered; 409 GUEST_SUSPENDED while the Guest’s account is on hold (nothing is charged, and staff are alerted).',
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
      'Admins, and support staff with the REFUNDS permission. A confirmed booking: a Guest no-show is a Guest cancellation at the start time; a Host no-show a Host cancellation; a platform cancellation a full refund. A PENDING booking (a request, or one waiting for the Guest’s verification) is a platform cancellation only (409 NOT_CONFIRMED for a no-show): its card authorisation is released and its held dates freed. An ACTIVE trip only as a Guest no-show, when the Host did the check-in alone and the Guest hasn’t confirmed it (409 NOT_CANCELLABLE otherwise). Earlier refunds come off the refund. A booking whose payment is in a card dispute (a chargeback) is cancelled with nothing refunded or kept, as the dispute decides the money, and no payout or kept-fee share for the Host; staff are alerted to refund it if the dispute is won. Both parties are told, except the Host of an Instant Book that never reached them.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(adminCancelSchema) },
    responses: {
      200: jsonResponse('The booking', bookingResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/bookings/{id}/cancellation-preview',
    tags: ['Admin'],
    summary: 'Staff: what a cancellation would refund and cost',
    description:
      'For the reason chosen, from the same policy engine as the cancellation (plan §8.2): the Guest’s refund (less any earlier refunds), what’s kept and the Host’s share, any Host cancellation fee, or the authorisation released for a pending booking. `allowed` is false, with the reason in `message`, when that cancellation isn’t possible.',
    security: signedIn,
    request: { params: idParam, query: adminCancellationPreviewQuerySchema },
    responses: {
      200: jsonResponse('The preview', adminCancellationPreviewSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/bookings/{id}/extra-charges/{chargeId}/cancel',
    tags: ['Admin'],
    summary: 'Staff with the refunds permission: cancel an extra charge that hasn’t been paid',
    description:
      'Only a PENDING or FAILED charge (409 NOT_CANCELLABLE otherwise; 409 ALREADY_PAID when the Guest paid it a moment ago, to refund instead). Its PaymentIntent and retries stop, it’s no longer owed, its pay link says it was cancelled, the Guest is told, and the reason goes to the audit log (plan §8.1, item 11).',
    security: signedIn,
    request: {
      params: idParam.extend({ chargeId: z.string().meta({ description: 'The extra charge’s id' }) }),
      body: jsonBody(cancelExtraChargeSchema),
    },
    responses: {
      200: jsonResponse('The booking’s whole record', adminBookingDetailSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/users/{id}/identity-review',
    tags: ['Admin'],
    summary: 'Staff: decide an identity check that needed a manual review',
    description:
      'Approving confirms the Guest’s bookings that waited for the check (capturing their card authorisations), except requests their Host still has to accept. Rejecting ends those bookings and releases the authorisations (plan §8.2); their confirmed trips stay booked (`stillBooked`), and support are alerted to each to decide.',
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
