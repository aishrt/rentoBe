import { z } from 'zod';
import { cancellationTierSchema } from '../admin/platform-settings.schemas.js';
import { PAYMENT_STATUSES } from '../payments/payment.model.js';
import { PAYOUT_HOLD_REASONS, PAYOUT_STATUSES } from '../payouts/payout.model.js';
import { ratingSchema } from '../search/search.schemas.js';
import {
  deliveryAddressSchema,
  deliveryOptionSummarySchema,
  guestPriceSchema,
  lineItemSchema,
  protectionPlanSummarySchema,
} from '../vehicles/vehicles.schemas.js';
import {
  BOOKING_STATUSES,
  CANCELLATION_REASONS,
  EXTRA_CHARGE_TYPES,
  VERIFICATION_REVIEW_STATUSES,
} from './booking.model.js';

/* The booking flow (plan §9, Days 11–14; spec §7) and the booking lifecycle (plan §8.2). */

export const createBookingSchema = z
  .object({
    vehicleId: z.string().regex(/^[0-9a-f]{24}$/, { error: 'Unknown car' }),
    start: z.string().meta({ description: '"2026-10-12T10:00" in NZ time, or ISO 8601 with an offset' }),
    end: z.string(),
    pickupOptionId: z.string().optional(),
    returnOptionId: z.string().optional(),
    deliveryAddress: deliveryAddressSchema.optional(),
    protectionPlanCode: z.string().optional(),
  })
  .meta({ id: 'CreateBookingRequest' });
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const preparePaymentSchema = z
  .object({ acceptGuestAgreement: z.literal(true, { error: 'Please accept the Guest Agreement' }) })
  .meta({ id: 'PreparePaymentRequest' });

export const paymentSessionSchema = z
  .object({
    clientSecret: z
      .string()
      .meta({ description: 'For Stripe.js to confirm this payment. Never logged or stored.' }),
    customerSessionClientSecret: z
      .string()
      .optional()
      .meta({ description: 'Lets the Payment Element show the Guest’s saved cards' }),
    amountCents: z.number().int(),
    currency: z.literal('nzd'),
    captureMethod: z.enum(['automatic', 'manual']).meta({
      description:
        'manual: authorised now, and charged when the Host accepts or the Guest’s verification is approved',
    }),
    verificationInReview: z.boolean().meta({
      description: 'The Guest’s identity check is with support, so the booking waits for it (plan §8.2)',
    }),
    holdExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'PaymentSession' });
export type PaymentSession = z.infer<typeof paymentSessionSchema>;

export const cancelBookingSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .meta({ id: 'CancelBookingRequest' });

export const declineBookingSchema = cancelBookingSchema.meta({ id: 'DeclineBookingRequest' });

export const identityReviewSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'IdentityReviewRequest' });

export const identityReviewResponseSchema = z
  .object({
    identityStatus: z.enum(['APPROVED', 'REJECTED']),
    confirmed: z.array(z.string()).meta({ description: 'References of the bookings this confirmed' }),
    waitingForHost: z.array(z.string()).meta({ description: 'Requests the Host still has to answer' }),
    released: z
      .array(z.string())
      .meta({ description: 'Bookings ended, with the card authorisation released' }),
  })
  .meta({ id: 'IdentityReviewResponse' });
export type IdentityReviewResult = z.infer<typeof identityReviewResponseSchema>;

export const adminCancelSchema = z
  .object({
    reason: z.enum(['GUEST_NO_SHOW', 'HOST_NO_SHOW', 'PLATFORM']),
    note: z.string().trim().min(3, { error: 'Say why' }).max(500),
  })
  .meta({ id: 'AdminCancelRequest' });

const partySchema = z.object({
  firstName: z.string(),
  avatarUrl: z.string().optional(),
  verified: z.boolean().meta({ description: 'Identity verified' }),
  rating: ratingSchema,
  tripCount: z.number().int(),
  phone: z.string().optional().meta({ description: 'Only on a confirmed booking (plan §6.2)' }),
});

const tripPointSchema = deliveryOptionSummarySchema.extend({
  address: z.string().optional().meta({
    description:
      'The exact address: the Guest’s own delivery address, or the Host’s once the booking is confirmed',
  }),
  instructions: z.string().optional().meta({ description: 'Once the booking is confirmed' }),
});

const verificationReviewSchema = z.enum(VERIFICATION_REVIEW_STATUSES).optional().meta({
  description:
    'Set when the Guest paid while their verification was in review. PENDING: the booking waits for support to approve the check (plan §8.2)',
});

const hostAcceptedSchema = z.boolean().optional().meta({
  description: 'PENDING: the Host has accepted, and the booking now waits only for the Guest’s verification',
});

/** Where a charge after the trip stands, as both parties see it. */
export const BOOKING_EXTRA_CHARGE_STATUSES = ['PENDING', 'PAID', 'UNPAID', 'FAILED', 'CANCELLED'] as const;

const bookingExtraChargeSchema = z.object({
  id: z.string(),
  type: z.enum(EXTRA_CHARGE_TYPES),
  description: z.string().meta({ description: 'What it’s for, e.g. "50 km over the 750 km included"' }),
  amountCents: z.number().int().meta({ description: 'Including GST' }),
  status: z.enum(BOOKING_EXTRA_CHARGE_STATUSES).meta({
    description:
      'PENDING: being charged to the saved card. UNPAID: the saved card didn’t go through, so the Guest has a link to pay it, and it’s tried again. FAILED: it couldn’t be collected. CANCELLED: taken off by support',
  }),
  addedAt: z.iso.datetime(),
  payPath: z
    .string()
    .optional()
    .meta({ description: 'The Guest’s view of an UNPAID charge: /pay/{paymentId}' }),
});

export const bookingViewSchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    status: z.enum(BOOKING_STATUSES),
    role: z
      .enum(['GUEST', 'HOST', 'STAFF'])
      .meta({ description: 'How the signed-in user sees this booking' }),
    instantBook: z.boolean(),
    vehicle: z.object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      photoUrl: z.string().optional(),
      regoPlate: z
        .string()
        .optional()
        .meta({ description: 'The Guest sees it once confirmed, to find the car' }),
    }),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    days: z.number().int(),
    pickup: tripPointSchema,
    dropoff: tripPointSchema,
    protectionPlan: protectionPlanSummarySchema
      .omit({ dailyPriceCents: true })
      .extend({ priceCents: z.number().int() })
      .nullable(),
    cancellationTier: cancellationTierSchema.nullable(),
    lineItems: z.array(lineItemSchema),
    price: guestPriceSchema,
    payout: z
      .object({
        hostPayoutCents: z.number().int(),
        platformFeeCents: z.number().int(),
        status: z.enum(PAYOUT_STATUSES).optional().meta({ description: 'Once confirmed: the trip’s payout' }),
        holdReason: z.enum(PAYOUT_HOLD_REASONS).optional(),
        scheduledFor: z.iso.datetime().optional(),
        paidAt: z.iso.datetime().optional(),
        expectedInBankBy: z.iso
          .datetime()
          .optional()
          .meta({ description: 'Once paid: usually in the Host’s bank by then' }),
        paidCents: z
          .number()
          .int()
          .optional()
          .meta({ description: 'Everything paid out for the booking so far' }),
      })
      .optional()
      .meta({ description: 'The Host’s view: what they earn and when it’s paid' }),
    holdExpiresAt: z.iso
      .datetime()
      .optional()
      .meta({ description: 'PAYMENT_PENDING: when the dates are released' }),
    requestExpiresAt: z.iso.datetime().optional().meta({ description: 'PENDING: when the request expires' }),
    verificationReview: verificationReviewSchema,
    hostAccepted: hostAcceptedSchema,
    guest: partySchema,
    host: partySchema.extend({ responseRate: z.number().optional() }),
    payment: z.object({ status: z.enum(PAYMENT_STATUSES), failureReason: z.string().optional() }).nullable(),
    cancellation: z
      .object({
        at: z.iso.datetime(),
        by: z.enum(['GUEST', 'HOST', 'SUPPORT']),
        reason: z.enum(CANCELLATION_REASONS).optional(),
        refundCents: z.number().int().optional(),
        feeCents: z.number().int().optional(),
        hostShareCents: z.number().int().optional(),
        hostFeeCents: z.number().int().optional(),
      })
      .nullable(),
    extraCharges: z.array(bookingExtraChargeSchema).optional().meta({
      description: 'Charges after the trip, such as extra kilometres or from an incident, oldest first',
    }),
    actions: z.object({
      pay: z.boolean(),
      cancel: z.boolean(),
      withdraw: z.boolean(),
      accept: z.boolean(),
      decline: z.boolean(),
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Booking' });
export type BookingView = z.infer<typeof bookingViewSchema>;

export const bookingResponseSchema = z.object({ booking: bookingViewSchema }).meta({ id: 'BookingResponse' });

export const BOOKING_GROUPS = ['upcoming', 'current', 'completed', 'cancelled', 'requests'] as const;

export const bookingSummarySchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    status: z.enum(BOOKING_STATUSES),
    instantBook: z.boolean(),
    vehicle: z.object({ slug: z.string(), title: z.string(), photoUrl: z.string().optional() }),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    otherParty: z.object({ firstName: z.string(), avatarUrl: z.string().optional() }),
    amountCents: z.number().int().meta({ description: 'The Guest’s total, or the Host’s payout' }),
    requestExpiresAt: z.iso.datetime().optional(),
    verificationReview: verificationReviewSchema,
    hostAccepted: hostAcceptedSchema,
  })
  .meta({ id: 'BookingSummary' });

export const bookingsQuerySchema = z.object({
  role: z.enum(['guest', 'host']).default('guest'),
  group: z.enum(BOOKING_GROUPS).optional(),
});

export const bookingsResponseSchema = z
  .object({ bookings: z.array(bookingSummarySchema) })
  .meta({ id: 'Bookings' });

export const cancellationPreviewSchema = z
  .object({
    allowed: z.boolean(),
    kind: z
      .enum(['ABANDON_CHECKOUT', 'WITHDRAW_REQUEST', 'GUEST_CANCELLATION', 'HOST_CANCELLATION'])
      .nullable(),
    refundCents: z.number().int(),
    feeCents: z.number().int(),
    hostShareCents: z.number().int().meta({ description: 'Host’s view: their share of a kept fee' }),
    hostFeeCents: z.number().int().meta({ description: 'Host’s view: a Host cancellation fee' }),
    refundPct: z.number(),
    hoursBeforeStart: z.number().int(),
    message: z.string().meta({ description: 'A sentence to show before the user confirms' }),
  })
  .meta({ id: 'CancellationPreview' });
export type CancellationPreview = z.infer<typeof cancellationPreviewSchema>;

const receiptRefundSchema = z.object({
  amountCents: z.number().int(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
  at: z.iso.datetime(),
});

export const receiptSchema = z
  .object({
    ref: z.string().meta({ description: 'The booking reference, which is also the receipt number' }),
    paidAt: z.iso.datetime(),
    supplier: z.object({
      name: z.string(),
      gstNumber: z.string().optional().meta({ description: 'Shown once the business is GST-registered' }),
      email: z.string(),
    }),
    customer: z.object({ name: z.string(), email: z.string() }),
    vehicleTitle: z.string(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    days: z.number().int(),
    lines: z.array(
      z.object({ label: z.string(), amountCents: z.number().int(), gstCents: z.number().int() }),
    ),
    totalCents: z.number().int(),
    gstCents: z.number().int().meta({ description: 'The GST included in the total' }),
    gstRatePct: z.number(),
    paidWith: z.string().meta({ description: 'e.g. "Visa ending 4242" or "Apple Pay (Visa ending 4242)"' }),
    refunds: z.array(receiptRefundSchema),
    refundedCents: z.number().int(),
    netPaidCents: z.number().int().meta({ description: 'The total less refunds that went through' }),
    extraCharges: z
      .array(
        z.object({
          description: z.string(),
          amountCents: z.number().int(),
          gstCents: z.number().int().meta({ description: 'The GST included in the charge' }),
          paidAt: z.iso.datetime(),
          paidWith: z.string(),
        }),
      )
      .optional()
      .meta({
        description:
          'Charges after the trip that were paid (plan §8.1, items 6 and 11), each charged on its own; left out when there are none',
      }),
  })
  .meta({
    id: 'Receipt',
    description:
      'The GST receipt for a paid booking (plan §8.1, item 18): every line, the GST included and the total in NZD',
  });
export type Receipt = z.infer<typeof receiptSchema>;

export const receiptResponseSchema = z.object({ receipt: receiptSchema }).meta({ id: 'ReceiptResponse' });
