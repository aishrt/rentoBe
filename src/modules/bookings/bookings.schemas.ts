import { z } from 'zod';
import { cancellationTierSchema } from '../admin/platform-settings.schemas.js';
import { PAYMENT_STATUSES } from '../payments/payment.model.js';
import {
  DEDUCTION_TYPES,
  PAYOUT_HOLD_REASONS,
  PAYOUT_STATUSES,
  PAYOUT_TYPES,
} from '../payouts/payout.model.js';
import { ratingSchema } from '../search/search.schemas.js';
import {
  deliveryAddressSchema,
  deliveryOptionSummarySchema,
  guestPriceSchema,
  lineItemSchema,
  protectionPlanSummarySchema,
} from '../vehicles/vehicles.schemas.js';
import { FUEL_POLICIES } from '../vehicles/vehicle.model.js';
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
  .object({
    reason: z.string().trim().max(500).optional(),
    expectedRefundCents: z.number().int().min(0).optional().meta({
      description:
        'The refund the preview showed: when the refund worked out now is less, nothing is cancelled (409 REFUND_CHANGED, with the new preview’s message in fields.expectedRefundCents)',
    }),
  })
  .meta({ id: 'CancelBookingRequest' });

export const declineBookingSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .meta({ id: 'DeclineBookingRequest' });

export const identityReviewSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'IdentityReviewRequest' });

/** What a support decision on a Guest's identity check or licence did to the bookings waiting for it. */
export const verificationOutcomeShape = {
  confirmed: z.array(z.string()).meta({ description: 'References of the bookings this confirmed' }),
  waitingForHost: z.array(z.string()).meta({ description: 'Requests the Host still has to answer' }),
  released: z.array(z.string()).meta({ description: 'Bookings ended, with the card authorisation released' }),
  stillInReview: z.array(z.string()).optional().meta({
    description:
      'Set when the other part (the identity check or the licence) still waits for support: the bookings that keep waiting for it',
  }),
  carSuspended: z.array(z.string()).optional().meta({
    description:
      'Bookings not confirmed because their car (or its Host) is suspended: confirmed when the suspension is lifted, unless their time runs out first',
  }),
  licenceNotEligible: z.array(z.string()).optional().meta({
    description:
      'Bookings not confirmed because the Guest’s licence no longer meets the rules for that trip (it expires before the trip ends, say): they keep waiting until the Guest updates it, support cancels them or their time runs out',
  }),
};
export type VerificationOutcome = {
  confirmed: string[];
  waitingForHost: string[];
  released: string[];
  stillInReview?: string[];
  carSuspended?: string[];
  licenceNotEligible?: string[];
};

export const identityReviewResponseSchema = z
  .object({
    identityStatus: z.enum(['APPROVED', 'REJECTED']),
    ...verificationOutcomeShape,
    stillBooked: z.array(z.string()).optional().meta({
      description:
        'Set when a turned-down check leaves the Guest with confirmed trips: they stay booked, and support are alerted to each to decide (check-in refuses them unless the licence is approved)',
    }),
  })
  .meta({ id: 'IdentityReviewResponse' });
export type IdentityReviewResult = z.infer<typeof identityReviewResponseSchema>;

/**
 * Why staff cancel (plan §8.2): a no-show (a confirmed booking only), a Host cancellation made for the Host
 * (e.g. the car's documents ran out, or a suspended car whose Host is at fault), or a platform cancellation.
 */
export const ADMIN_CANCEL_REASONS = ['GUEST_NO_SHOW', 'HOST_NO_SHOW', 'HOST_CANCELLED', 'PLATFORM'] as const;
export type AdminCancelReason = (typeof ADMIN_CANCEL_REASONS)[number];

export const adminCancelSchema = z
  .object({
    reason: z.enum(ADMIN_CANCEL_REASONS),
    note: z.string().trim().min(3, { error: 'Say why' }).max(500),
  })
  .meta({ id: 'AdminCancelRequest' });

export const adminCancellationPreviewQuerySchema = z.object({
  reason: z.enum(ADMIN_CANCEL_REASONS),
});

/** What a staff cancellation would refund and cost, for the reason chosen (plan §8.2: refund preview). */
export const adminCancellationPreviewSchema = z
  .object({
    reason: z.enum(ADMIN_CANCEL_REASONS),
    allowed: z.boolean(),
    kind: z
      .enum(['GUEST_CANCELLATION', 'HOST_CANCELLATION', 'PLATFORM_CANCELLATION'])
      .nullable()
      .meta({ description: 'How the policy engine treats it: a no-show is a Guest or Host cancellation' }),
    refundCents: z.number().int().meta({ description: 'Back to the Guest’s card' }),
    feeCents: z.number().int().meta({ description: 'What the Guest paid and doesn’t get back' }),
    hostShareCents: z.number().int().meta({ description: 'The Host’s share of the kept fee' }),
    hostFeeCents: z.number().int().meta({ description: 'A Host cancellation fee, off their next payout' }),
    releasedCents: z.number().int().meta({
      description:
        'A request or a booking waiting for verification: the card authorisation released, as nothing was charged',
    }),
    refundPct: z.number(),
    hoursBeforeStart: z.number().int(),
    message: z.string().meta({ description: 'A sentence to show before staff confirm' }),
  })
  .meta({ id: 'AdminCancellationPreview' });
export type AdminCancellationPreview = z.infer<typeof adminCancellationPreviewSchema>;

const partySchema = z.object({
  id: z
    .string()
    .optional()
    .meta({ description: 'For their public profile; missing once an account is gone' }),
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

/**
 * Why a booking expired (plan §8.2: each labelled). PAYMENT_TIMEOUT: not paid within the 30-minute hold.
 * CHECKOUT_ABANDONED: the Guest left or replaced the checkout. HOST_NO_ANSWER: the Host didn't answer the
 * request in time. VERIFICATION_EXPIRED / VERIFICATION_REJECTED: the Guest's verification wasn't
 * approved in time, or was rejected. DATES_TAKEN / CAR_UNAVAILABLE: the payment went through after the dates
 * were booked by someone else, or after the car was taken off the site.
 */
export const EXPIRY_REASONS = [
  'PAYMENT_TIMEOUT',
  'CHECKOUT_ABANDONED',
  'HOST_NO_ANSWER',
  'VERIFICATION_EXPIRED',
  'VERIFICATION_REJECTED',
  'DATES_TAKEN',
  'CAR_UNAVAILABLE',
] as const;

const refundStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED']);

/** Where a charge after the trip stands, as both parties see it. */
export const BOOKING_EXTRA_CHARGE_STATUSES = [
  'PENDING',
  'PAID',
  'UNPAID',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const;

const bookingExtraChargeSchema = z.object({
  id: z.string(),
  type: z.enum(EXTRA_CHARGE_TYPES),
  description: z.string().meta({ description: 'What it’s for, e.g. "50 km over the 750 km included"' }),
  amountCents: z.number().int().meta({ description: 'Including GST' }),
  status: z.enum(BOOKING_EXTRA_CHARGE_STATUSES).meta({
    description:
      'PENDING: being charged to the saved card. UNPAID: the saved card didn’t go through, so the Guest has a link to pay it, and it’s tried again. FAILED: it couldn’t be collected. CANCELLED: taken off by support. REFUNDED: paid, and all of it given back',
  }),
  refundedCents: z
    .number()
    .int()
    .optional()
    .meta({ description: 'A paid charge’s refunds that didn’t fail; left out when none' }),
  addedAt: z.iso.datetime(),
  payPath: z
    .string()
    .optional()
    .meta({ description: 'The Guest’s view of an UNPAID charge: /pay/{paymentId}' }),
});

/** The fuel and kilometre terms as booked (plan §3: later listing changes don't apply to the trip). */
const bookedTermsSchema = z.object({
  fuelPolicy: z.enum(FUEL_POLICIES),
  unlimitedKm: z.boolean(),
  kmAllowancePerDay: z
    .number()
    .int()
    .optional()
    .meta({ description: 'Left out when kilometres are unlimited' }),
  allowanceKm: z
    .number()
    .int()
    .optional()
    .meta({ description: 'The whole trip’s allowance: the daily allowance times the trip’s days' }),
  extraKmCents: z.number().int().meta({ description: 'For each kilometre over the allowance' }),
  electric: z.boolean().meta({ description: 'An electric car: its fuel policy is about battery charge' }),
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
    terms: bookedTermsSchema,
    lineItems: z.array(lineItemSchema),
    price: guestPriceSchema,
    payout: z
      .object({
        hostPayoutCents: z.number().int(),
        commissionCents: z.number().int().meta({
          description:
            'The platform’s commission on the rental and delivery, as the trip’s payout was made with it',
        }),
        commissionGstCents: z.number().int().meta({ description: 'The GST included in the commission' }),
        type: z.enum(PAYOUT_TYPES).optional().meta({
          description: 'The payout below: the trip’s, or a cancelled booking’s share of the kept fee',
        }),
        status: z.enum(PAYOUT_STATUSES).optional().meta({ description: 'Once confirmed: the trip’s payout' }),
        holdReason: z.enum(PAYOUT_HOLD_REASONS).optional(),
        scheduledFor: z.iso.datetime().optional(),
        paidAt: z.iso.datetime().optional(),
        expectedInBankBy: z.iso
          .datetime()
          .optional()
          .meta({ description: 'Once paid: usually in the Host’s bank by then' }),
        paidCents: z.number().int().optional().meta({
          description: 'Everything paid out for the booking so far, less any taken back for refunds',
        }),
        earnings: z
          .object({
            rentalCents: z.number().int(),
            deliveryCents: z.number().int(),
            extraChargesCents: z.number().int(),
            keptFeeCents: z
              .number()
              .int()
              .meta({ description: 'Cancelled: the Host’s part of the fee kept, before commission' }),
            commissionCents: z.number().int(),
            commissionGstCents: z.number().int(),
            hostFundedRefundsCents: z.number().int(),
            hostCancellationFeeCents: z.number().int().meta({ description: 'Less any part waived' }),
            netCents: z.number().int(),
          })
          .optional()
          .meta({
            description:
              'Once confirmed (or cancelled): what the booking earned the Host, as its row on the earnings page and statement',
          }),
        settled: z
          .array(
            z.object({
              type: z.enum(DEDUCTION_TYPES),
              amountCents: z.number().int(),
              bookingRef: z.string().optional(),
              payoutSent: z
                .boolean()
                .optional()
                .meta({ description: 'A payout already sent for that booking, owed back' }),
            }),
          )
          .optional()
          .meta({
            description:
              'What this booking’s payouts settled for other bookings (Host cancellation fees, refunds, payouts already sent): part of what it earned, though not paid out',
          }),
        settledElsewhere: z
          .array(
            z.object({
              amountCents: z.number().int(),
              bookingRef: z.string().meta({ description: 'The booking whose payout it came off' }),
              payoutSent: z
                .boolean()
                .optional()
                .meta({ description: 'A payout already sent for this booking, rather than a refund' }),
            }),
          )
          .optional()
          .meta({ description: 'What the Host’s other payouts took off for this booking' }),
        owed: z
          .object({
            refundsCents: z.number().int(),
            payoutSentCents: z.number().int().meta({
              description: 'A trip payout sent before the booking was cancelled, less the Host’s share',
            }),
          })
          .optional()
          .meta({ description: 'Still owed for this booking, to come off the Host’s next payout' }),
        refunds: z
          .array(
            z.object({
              amountCents: z.number().int(),
              at: z.iso.datetime(),
              fundedBy: z
                .enum(['PLATFORM', 'HOST'])
                .meta({ description: 'HOST: it comes off the Host’s payout (plan §8.1, item 15)' }),
              hostCents: z.number().int().optional().meta({
                description:
                  'HOST: what the Host pays back for it, their share; Rento Vroom covers its commission',
              }),
              cancellation: z.boolean().optional().meta({
                description:
                  'The cancellation’s own refund, settled by the policy rather than the Host’s payout',
              }),
              extraCharge: z
                .boolean()
                .optional()
                .meta({ description: 'A refund of one of the booking’s extra charges' }),
            }),
          )
          .optional()
          .meta({
            description: 'Refunds made to the Guest on the booking and its extra charges, oldest first',
          }),
      })
      .optional()
      .meta({ description: 'The Host’s view: what they earn and when it’s paid' }),
    holdExpiresAt: z.iso
      .datetime()
      .optional()
      .meta({ description: 'PAYMENT_PENDING: when the dates are released' }),
    paymentProcessing: z.boolean().optional().meta({
      description:
        'PAYMENT_PENDING past holdExpiresAt: the payment is still processing at the bank, so the dates stay held until it succeeds or fails',
    }),
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
        refundStatus: refundStatusSchema.optional().meta({
          description:
            'Where the refund stands, once one was made: PENDING (on its way), SUCCEEDED, or FAILED (support returns it another way)',
        }),
        feeCents: z.number().int().optional(),
        earlierRefundCents: z.number().int().optional().meta({
          description:
            'Refunds made before the cancellation, which came off what it could give back (all of the payment, when the refund is 0 and nothing was kept)',
        }),
        disputed: z.boolean().optional().meta({
          description:
            'Cancelled by support while the payment was in a card dispute (a chargeback): the dispute decides what goes back to the card, so the cancellation refunded and kept nothing',
        }),
        hostShareCents: z.number().int().optional(),
        hostFeeCents: z.number().int().optional(),
      })
      .nullable(),
    expiry: z
      .object({
        reason: z.enum(EXPIRY_REASONS),
        paymentReturned: z.boolean().meta({
          description:
            'The Guest’s card was charged after the booking ended, so the payment is refunded in full (an authorisation is only released)',
        }),
        refundCents: z.number().int().optional(),
        refundStatus: refundStatusSchema.optional(),
      })
      .optional()
      .meta({ description: 'EXPIRED: why, and whether a payment that went through was given back' }),
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
    otherParty: z.object({
      firstName: z.string(),
      avatarUrl: z.string().optional(),
      // The Guest, in the Host's lists (plan §6.2: verified or not, rating and trips; never the documents).
      verified: z.boolean().optional(),
      rating: z.object({ avg: z.number(), count: z.number().int() }).optional(),
      tripCount: z.number().int().optional(),
    }),
    amountCents: z.number().int().meta({ description: 'The Guest’s total, or the Host’s payout' }),
    requestExpiresAt: z.iso.datetime().optional(),
    verificationReview: verificationReviewSchema,
    hostAccepted: hostAcceptedSchema,
  })
  .meta({ id: 'BookingSummary' });

/** Bookings on each page of a list. */
export const BOOKINGS_PAGE_SIZE = 100;

export const bookingsQuerySchema = z.object({
  role: z.enum(['guest', 'host']).default('guest'),
  group: z.enum(BOOKING_GROUPS).optional(),
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(1)
    .meta({ description: `Each page has up to ${BOOKINGS_PAGE_SIZE} bookings` }),
});

export const bookingsResponseSchema = z
  .object({
    bookings: z.array(bookingSummarySchema),
    nextPage: z.number().int().optional().meta({ description: 'Set when there are more bookings' }),
  })
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
          refunds: z
            .array(receiptRefundSchema)
            .optional()
            .meta({ description: 'Refunds made on the charge since; left out when there are none' }),
          refundedCents: z
            .number()
            .int()
            .optional()
            .meta({ description: 'Its refunds that went through; set with refunds' }),
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
