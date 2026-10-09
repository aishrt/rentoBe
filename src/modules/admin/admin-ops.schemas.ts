import { z } from 'zod';
import { NZ_REGIONS } from '../../lib/model-fields.js';
import { BOOKING_STATUSES, EXTRA_CHARGE_STATUSES, EXTRA_CHARGE_TYPES } from '../bookings/booking.model.js';
import { bookingViewSchema } from '../bookings/bookings.schemas.js';
import { homeHeroSchema, isLinkAddress, legalPageSchema, siteFooterSchema } from '../cms/content.schemas.js';
import { INCIDENT_STATUSES, INCIDENT_TYPES } from '../incidents/incident.model.js';
import { PAYMENT_STATUSES, PAYMENT_TYPES, REFUND_FUNDERS, REFUND_KINDS } from '../payments/payment.model.js';
import { PAYOUT_HOLD_REASONS, PAYOUT_STATUSES, PAYOUT_TYPES } from '../payouts/payout.model.js';
import { REPORT_STATUSES, REPORT_TARGET_TYPES } from '../moderation/report.model.js';
import { moderationReviewSchema } from '../reviews/reviews.schemas.js';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '../support/support-ticket.model.js';
import { ticketFilesSchema } from '../support/support.schemas.js';
import { attachmentViewSchema } from '../uploads/uploads.schemas.js';
import {
  EMAIL_PROBLEMS,
  HOST_STATUSES,
  ROLES,
  USER_STATUSES,
  VERIFICATION_STATUSES,
} from '../users/user.model.js';
import { VEHICLE_STATUSES } from '../vehicles/vehicle.model.js';

/* The staff portal's operations (spec §18; plan §9 Days 19–23). */

const iso = z.iso.datetime();
const cents = z.number().int();
const page = z.coerce.number().int().min(1).max(500).default(1);
const reason = z.string().trim().min(3, { error: 'Say why' }).max(500);

// Overview ---------------------------------------------------------------------------------------------------

export const overviewQuerySchema = z.object({
  from: z.iso
    .date()
    .optional()
    .meta({ description: 'First NZ day of the range; the last 30 days when left out' }),
  to: z.iso.date().optional().meta({ description: 'Last NZ day, inclusive' }),
});

export const adminDashboardSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    figures: z.object({
      totalUsers: z.number().int(),
      activeHosts: z.number().int(),
      activeVehicles: z.number().int(),
      upcomingBookings: z.number().int(),
      bookingRevenueCents: cents.meta({ description: 'Paid for bookings made in the range, less refunds' }),
      platformFeesCents: cents.meta({
        description: 'Service fees and commission on bookings made in the range',
      }),
      hostPayoutsCents: cents.meta({ description: 'Paid to Hosts in the range' }),
      cancellations: z.number().int(),
      incidentCases: z.number().int().meta({ description: 'Opened in the range' }),
      openIncidentCases: z.number().int(),
      pendingVerifications: z.number().int(),
      suspendedUsers: z.number().int(),
      suspendedVehicles: z.number().int(),
    }),
    queues: z.object({
      hostApplications: z.number().int(),
      listingReviews: z.number().int(),
      verifications: z.number().int(),
      incidents: z.number().int(),
      supportTickets: z.number().int(),
      reports: z.number().int(),
      heldReviews: z.number().int(),
      riskFlags: z.number().int(),
      failedPayments: z.number().int(),
      heldPayouts: z.number().int(),
      failedJobs: z.number().int(),
    }),
    generatedAt: iso,
  })
  .meta({ id: 'AdminDashboard' });

// Users ------------------------------------------------------------------------------------------------------

export const userListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().meta({ description: 'Name, email or mobile' }),
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  flagged: z.enum(['true']).optional().meta({ description: 'Only people with a risk flag to review' }),
  page,
});

export const adminUserRowSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string().optional(),
    roles: z.array(z.enum(ROLES)),
    status: z.enum(USER_STATUSES),
    closed: z.boolean(),
    identityStatus: z.enum(VERIFICATION_STATUSES),
    hostStatus: z.enum(HOST_STATUSES).nullable(),
    openRiskFlags: z.number().int(),
    createdAt: iso,
  })
  .meta({ id: 'AdminUserRow' });

export const adminUsersResponseSchema = z
  .object({ users: z.array(adminUserRowSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminUsers' });

export const bookingRowSchema = z
  .object({
    id: z.string(),
    ref: z.string(),
    status: z.enum(BOOKING_STATUSES),
    vehicleTitle: z.string(),
    guest: z.object({ id: z.string(), name: z.string() }),
    host: z.object({ id: z.string(), name: z.string() }),
    start: iso,
    end: iso,
    totalCents: cents,
    createdAt: iso,
  })
  .meta({ id: 'AdminBookingRow' });

export const riskFlagViewSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    detail: z.string().optional(),
    createdAt: iso,
    clearedAt: iso.optional(),
  })
  .meta({ id: 'RiskFlag' });

export const adminUserDetailSchema = adminUserRowSchema
  .extend({
    suspendedReason: z.string().optional(),
    emailVerified: z.boolean(),
    emailProblem: z
      .object({ kind: z.enum(EMAIL_PROBLEMS), detail: z.string().optional(), at: iso })
      .optional()
      .meta({
        description:
          "Emails to the address bounced, or Resend won't send to it (plan §7). Cleared by the next delivery.",
      }),
    phoneVerified: z.boolean(),
    permissions: z.array(z.string()),
    lastLoginAt: iso.optional(),
    licence: z
      .object({
        class: z.string(),
        country: z.string(),
        numberEnding: z.string(),
        expiry: z.string(),
        status: z.string(),
        version: z.string().optional(),
        issuedAt: z.string().optional(),
        inEnglish: z.boolean().optional().meta({ description: 'Overseas: false when it isn’t in English' }),
        englishProof: z.string().optional(),
      })
      .nullable(),
    dob: z.string().optional().meta({ description: 'Their date of birth, to compare with the licence' }),
    identityDocument: z
      .object({
        type: z.string().optional().meta({ description: 'driving_license, passport or id_card' }),
        licenceNumberMatched: z.boolean().optional(),
        dobMatched: z.boolean().optional(),
      })
      .optional()
      .meta({
        description:
          'The ID used in the identity check: a driver licence’s number compared with the licence on the account now, and the date of birth compared when it was checked',
      }),
    host: z
      .object({
        status: z.enum(HOST_STATUSES),
        payoutsEnabled: z.boolean(),
        feesOwedCents: cents,
        tripCount: z.number().int(),
        rating: z.object({ avg: z.number(), count: z.number().int() }),
        vehicles: z.number().int(),
      })
      .nullable(),
    riskFlags: z.array(riskFlagViewSchema),
    bookings: z.array(bookingRowSchema).meta({ description: 'As Guest and as Host, newest first' }),
    upcomingBookings: z
      .array(bookingRowSchema)
      .meta({ description: 'Confirmed or pending trips still to come: what a suspension affects' }),
  })
  .meta({ id: 'AdminUserDetail' });

export const adminUserResponseSchema = z
  .object({ user: adminUserDetailSchema })
  .meta({ id: 'AdminUserResponse' });

export const suspendSchema = z.object({ reason }).meta({ id: 'SuspendRequest' });
export const permissionsSchema = z.object({ refunds: z.boolean() }).meta({ id: 'StaffPermissionsRequest' });
export const waiveFeeSchema = z
  .object({
    amountCents: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: 'Leave out to waive everything owed' }),
    reason,
  })
  .meta({ id: 'WaiveFeeRequest' });

// Bookings ---------------------------------------------------------------------------------------------------

export const bookingListQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .meta({ description: 'Booking reference, guest or host name or email' }),
  status: z.enum(BOOKING_STATUSES).optional(),
  from: z.iso.date().optional().meta({ description: 'Trips starting on or after this NZ date' }),
  to: z.iso.date().optional(),
  page,
});

export const adminBookingsResponseSchema = z
  .object({ bookings: z.array(bookingRowSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminBookings' });

export const adminStatusEditSchema = z
  .object({
    to: z.enum(['ACTIVE', 'COMPLETED']).meta({
      description: 'ACTIVE: the trip started without a check-in in the app. COMPLETED: mark it completed.',
    }),
    reason,
  })
  .meta({ id: 'AdminStatusEditRequest' });

export const adminRefundSchema = z
  .object({
    paymentId: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .optional()
      .meta({
        description:
          'One of the booking’s payments to refund, e.g. an extra charge (plan §8.1, item 11). Leave out for the booking’s own payment.',
      }),
    amountCents: z.number().int().min(1, { error: 'Enter an amount' }),
    reason,
    fundedBy: z.enum(['PLATFORM', 'HOST']).meta({
      description:
        'PLATFORM: a goodwill refund. HOST: rental the Host would otherwise get (plan §8.1, item 15).',
    }),
    recoverFrom: z.enum(['NEXT_PAYOUT', 'REVERSE_TRANSFER']).optional().meta({
      description:
        'A Host-funded refund once the trip’s payout was sent: take it off the Host’s next payout (the default), or reverse the Stripe transfer. If Stripe refuses the reversal, it comes off the next payout.',
    }),
  })
  .meta({ id: 'AdminRefundRequest' });

// Payments and payouts ---------------------------------------------------------------------------------------

export const adminPaymentSchema = z
  .object({
    id: z.string(),
    bookingRef: z.string(),
    guestName: z.string(),
    type: z.enum(PAYMENT_TYPES),
    amountCents: cents,
    status: z.enum(PAYMENT_STATUSES),
    method: z.string().optional(),
    failureReason: z.string().optional(),
    refundedCents: cents,
    refunds: z.array(
      z.object({
        amountCents: cents,
        reason: z.string(),
        fundedBy: z.enum(['PLATFORM', 'HOST']),
        status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
        failureReason: z.string().optional(),
        at: iso,
      }),
    ),
    dispute: z
      .object({ status: z.string(), reason: z.string().optional(), dueBy: iso.optional() })
      .optional(),
    createdAt: iso,
  })
  .meta({ id: 'AdminPayment' });

export const paymentListQuerySchema = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  type: z.enum(PAYMENT_TYPES).optional(),
  view: z.enum(['all', 'failed', 'disputed', 'refunds-failed']).default('all'),
  page,
});

export const adminPaymentsResponseSchema = z
  .object({ payments: z.array(adminPaymentSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminPayments' });

export const adminPayoutSchema = z
  .object({
    id: z.string(),
    bookingRef: z.string(),
    host: z.object({ id: z.string(), name: z.string() }),
    type: z.enum(PAYOUT_TYPES),
    status: z.enum(PAYOUT_STATUSES),
    holdReason: z.enum(PAYOUT_HOLD_REASONS).optional(),
    amountCents: cents,
    deductedCents: cents,
    scheduledFor: iso,
    paidAt: iso.optional(),
    failureReason: z.string().optional(),
  })
  .meta({ id: 'AdminPayout' });

export const payoutListQuerySchema = z.object({ status: z.enum(PAYOUT_STATUSES).optional(), page });

export const adminPayoutsResponseSchema = z
  .object({ payouts: z.array(adminPayoutSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminPayouts' });

export const holdPayoutSchema = z.object({ reason }).meta({ id: 'HoldPayoutRequest' });

// Refunds ----------------------------------------------------------------------------------------------------

const REFUND_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;

export const refundListQuerySchema = z.object({
  q: z.string().trim().max(20).optional().meta({ description: 'A booking reference, or part of one' }),
  status: z.enum(REFUND_STATUSES).optional(),
  fundedBy: z.enum(REFUND_FUNDERS).optional(),
  kind: z.enum(REFUND_KINDS).optional(),
  page,
});

export const adminRefundRowSchema = z
  .object({
    id: z.string(),
    paymentId: z.string(),
    paymentType: z.enum(PAYMENT_TYPES),
    bookingRef: z.string(),
    guest: z.object({ id: z.string(), name: z.string() }),
    amountCents: cents,
    reason: z.string(),
    kind: z.enum(REFUND_KINDS).optional().meta({
      description:
        'A cancellation’s own refund, a payment that arrived after its booking ended, or one staff issued. Older refunds have none.',
    }),
    fundedBy: z.enum(REFUND_FUNDERS),
    status: z.enum(REFUND_STATUSES),
    failureReason: z.string().optional(),
    issuedBy: z
      .object({ id: z.string(), name: z.string() })
      .optional()
      .meta({ description: 'Staff refunds' }),
    hostRecovery: z
      .object({
        deductedCents: cents.meta({ description: 'Taken off the Host’s payouts' }),
        reversedCents: cents.meta({ description: 'Taken back from a paid payout’s Stripe transfer' }),
        owedCents: cents.meta({ description: 'Still owed: comes off the Host’s next payout' }),
      })
      .optional()
      .meta({
        description: 'A Host-funded refund: how it has been recovered from the Host (plan §8.1, item 15)',
      }),
    createdAt: iso,
  })
  .meta({ id: 'AdminRefundRow' });

export const adminRefundsResponseSchema = z
  .object({ refunds: z.array(adminRefundRowSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminRefunds' });

// Unpaid extra charges ---------------------------------------------------------------------------------------

export const extraChargeListQuerySchema = z.object({
  status: z.enum(['PENDING', 'FAILED']).optional().meta({ description: 'Both when left out' }),
  page,
});

export const adminExtraChargeRowSchema = z
  .object({
    id: z.string(),
    bookingRef: z.string(),
    guest: z.object({ id: z.string(), name: z.string() }),
    type: z.enum(EXTRA_CHARGE_TYPES),
    description: z.string(),
    amountCents: cents,
    status: z.enum(EXTRA_CHARGE_STATUSES),
    paymentStatus: z
      .enum(PAYMENT_STATUSES)
      .optional()
      .meta({ description: 'Its payment, once the saved card has been tried' }),
    failureReason: z.string().optional().meta({ description: 'Why the last try failed' }),
    attempts: z
      .number()
      .int()
      .optional()
      .meta({ description: 'Tries on the saved card so far, while their record is kept (30 days)' }),
    nextTryAt: iso.optional().meta({ description: 'When the saved card is tried again' }),
    incidentRef: z.string().optional().meta({ description: 'The case it was charged from' }),
    createdAt: iso,
  })
  .meta({ id: 'AdminExtraChargeRow' });

export const adminExtraChargesResponseSchema = z
  .object({ charges: z.array(adminExtraChargeRowSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminExtraCharges' });

const personSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().optional(),
});

export const adminBookingDetailSchema = z
  .object({
    booking: bookingViewSchema,
    guest: personSchema,
    host: personSchema,
    statusHistory: z.array(
      z.object({
        status: z.enum(BOOKING_STATUSES),
        at: iso,
        by: z.string().optional(),
        reason: z.string().optional(),
      }),
    ),
    extraCharges: z.array(
      z.object({
        id: z.string(),
        type: z.enum(EXTRA_CHARGE_TYPES),
        description: z.string(),
        amountCents: cents,
        status: z.enum(EXTRA_CHARGE_STATUSES),
      }),
    ),
    payments: z.array(adminPaymentSchema),
    payouts: z.array(adminPayoutSchema),
    incidents: z.array(
      z.object({ ref: z.string(), type: z.enum(INCIDENT_TYPES), status: z.enum(INCIDENT_STATUSES) }),
    ),
    tickets: z.array(z.object({ ref: z.string(), subject: z.string(), status: z.enum(TICKET_STATUSES) })),
    refundableCents: cents.meta({ description: 'What can still be refunded on the booking’s payment' }),
    tripPayoutSent: z.boolean().optional().meta({
      description:
        'The trip’s payout was sent (or is being sent, or the booking ended without one), so a Host-funded refund comes off the Host’s next payout or is taken back from the transfer',
    }),
    refundableCharges: z
      .array(
        z.object({
          paymentId: z.string(),
          type: z.enum(EXTRA_CHARGE_TYPES),
          description: z.string(),
          refundableCents: cents,
          payoutSent: z.boolean().meta({
            description:
              'The Host’s share of the charge was paid, so a Host-funded refund is taken back another way',
          }),
        }),
      )
      .meta({ description: 'Paid extra charges with something left to refund (plan §8.1, item 11)' }),
    hostRefund: z
      .object({
        recoveredFrom: z.enum(['THIS_PAYOUT', 'NEXT_PAYOUT', 'REVERSE_TRANSFER']),
        reversedCents: cents.optional(),
        owedCents: cents.optional().meta({ description: 'What comes off the Host’s next payout' }),
        note: z.string().optional().meta({ description: 'Why the transfer wasn’t reversed as asked' }),
      })
      .optional()
      .meta({
        description: 'After a Host-funded refund: how it’s recovered from the Host (plan §8.1, item 15)',
      }),
  })
  .meta({ id: 'AdminBookingDetail' });

// Vehicles ---------------------------------------------------------------------------------------------------

export const adminVehicleSuspensionSchema = z
  .object({
    vehicle: z.object({ id: z.string(), title: z.string(), status: z.enum(VEHICLE_STATUSES) }),
    upcomingBookings: z.array(bookingRowSchema),
  })
  .meta({ id: 'AdminVehicleSuspension' });

// Support inbox ----------------------------------------------------------------------------------------------

export const ticketListQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  q: z.string().trim().max(100).optional(),
  mine: z.enum(['true']).optional(),
  page,
});

export const staffTicketRowSchema = z
  .object({
    ref: z.string(),
    subject: z.string(),
    category: z.enum(TICKET_CATEGORIES),
    status: z.enum(TICKET_STATUSES),
    from: z.object({ name: z.string(), email: z.string(), userId: z.string().optional() }),
    bookingRef: z.string().optional(),
    assignedTo: z.string().optional(),
    messages: z.number().int(),
    updatedAt: iso,
    createdAt: iso,
  })
  .meta({ id: 'StaffTicketRow' });

export const staffTicketsResponseSchema = z
  .object({ tickets: z.array(staffTicketRowSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'StaffTickets' });

export const staffTicketSchema = staffTicketRowSchema
  .extend({
    thread: z.array(
      z.object({
        id: z.string(),
        from: z.enum(['USER', 'STAFF']),
        authorName: z.string(),
        body: z.string(),
        attachments: z.array(attachmentViewSchema),
        internal: z.boolean(),
        createdAt: iso,
      }),
    ),
  })
  .meta({ id: 'StaffTicket' });

export const staffTicketResponseSchema = z
  .object({ ticket: staffTicketSchema })
  .meta({ id: 'StaffTicketResponse' });

export const staffTicketReplySchema = z
  .object({
    body: z.string().trim().min(1, { error: 'Write a reply' }).max(5000),
    internal: z.boolean().default(false).meta({ description: 'A note for the team only' }),
    status: z.enum(TICKET_STATUSES).optional().meta({ description: 'Defaults to PENDING after a reply' }),
    attachments: ticketFilesSchema.default([]).meta({
      description:
        'Photos and PDFs uploaded first with purpose SUPPORT_FILE. A reply has them only when the sender has an account to see them in (400 otherwise); a note always can',
    }),
  })
  .meta({ id: 'StaffTicketReplyRequest' });

export const ticketUpdateSchema = z
  .object({ status: z.enum(TICKET_STATUSES).optional(), assignToMe: z.boolean().optional() })
  .meta({ id: 'TicketUpdateRequest' });

// Moderation and risk ----------------------------------------------------------------------------------------

export const adminReportSchema = z
  .object({
    id: z.string(),
    targetType: z.enum(REPORT_TARGET_TYPES),
    targetId: z.string(),
    reason: z.string(),
    note: z.string().optional(),
    status: z.enum(REPORT_STATUSES),
    reporter: z.object({ id: z.string(), name: z.string() }),
    subject: z.object({ id: z.string(), name: z.string() }).optional(),
    preview: z.string().meta({ description: 'What was reported: the message, review or listing' }),
    bookingRef: z.string().optional().meta({
      description:
        'A reported message’s booking, or the booking a member was reported from, to open its thread',
    }),
    // A reported review, whole, so staff can read it and hide it from the report.
    review: moderationReviewSchema.optional(),
    messageRemoved: z
      .object({ at: iso, reason: z.string().optional() })
      .optional()
      .meta({ description: 'A reported message support removed: when, and why' }),
    resolution: z.string().optional(),
    createdAt: iso,
  })
  .meta({ id: 'AdminReport' });

export const adminReportsResponseSchema = z
  .object({ reports: z.array(adminReportSchema) })
  .meta({ id: 'AdminReports' });

export const resolveReportSchema = z
  .object({ status: z.enum(['ACTIONED', 'DISMISSED']), resolution: reason })
  .meta({ id: 'ResolveReportRequest' });

export const riskQueueSchema = z
  .object({
    users: z.array(
      adminUserRowSchema.extend({ flags: z.array(riskFlagViewSchema) }).meta({ id: 'RiskUser' }),
    ),
  })
  .meta({ id: 'RiskQueue' });

// Content ----------------------------------------------------------------------------------------------------

export const featuredVehiclesSchema = z
  .object({ vehicleIds: z.array(z.string().regex(/^[0-9a-f]{24}$/)).max(8) })
  .meta({ id: 'FeaturedVehiclesInput' });

const adminVehicleChoiceSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    city: z.string().optional(),
    status: z.enum(VEHICLE_STATUSES),
    live: z
      .boolean()
      .meta({ description: 'In search now: a featured car that isn’t is left off the homepage' }),
  })
  .meta({ id: 'AdminVehicleChoice' });

export const adminFeaturedResponseSchema = z
  .object({ vehicleIds: z.array(z.string()), vehicles: z.array(adminVehicleChoiceSchema) })
  .meta({ id: 'AdminFeaturedVehicles' });

export const vehicleChoicesResponseSchema = z
  .object({ vehicles: z.array(adminVehicleChoiceSchema) })
  .meta({ id: 'AdminVehicleChoices' });

export const legalPagesResponseSchema = z
  .object({ pages: z.array(legalPageSchema) })
  .meta({ id: 'AdminLegalPages' });

export const adminDestinationSchema = z
  .object({
    slug: z.string(),
    city: z.string(),
    maoriName: z.string().optional(),
    region: z.string(),
    tagline: z.string().optional(),
    intro: z.string(),
    heroImage: z.string().optional(),
    lat: z.number(),
    lng: z.number(),
    airports: z.array(z.string()),
    featured: z.boolean(),
    order: z.number().int(),
    published: z
      .boolean()
      .meta({ description: 'False: off the homepage, a 404 page and out of the sitemap' }),
  })
  .meta({ id: 'AdminDestination' });

export const adminDestinationsResponseSchema = z
  .object({ destinations: z.array(adminDestinationSchema) })
  .meta({ id: 'AdminDestinations' });

export const adminFaqSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    answer: z.string(),
    category: z.string(),
    audience: z.enum(['GUEST', 'HOST', 'ALL']),
    showOnHome: z.boolean(),
    order: z.number().int(),
  })
  .meta({ id: 'AdminFaq' });

export const adminFaqsResponseSchema = z.object({ faqs: z.array(adminFaqSchema) }).meta({ id: 'AdminFaqs' });

export const adminHelpArticleSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    body: z.string(),
    category: z.string(),
    audience: z.enum(['GUEST', 'HOST', 'ALL']),
    published: z.boolean(),
    order: z.number().int(),
    updatedAt: iso,
  })
  .meta({ id: 'AdminHelpArticle' });

export const adminHelpArticlesResponseSchema = z
  .object({ articles: z.array(adminHelpArticleSchema) })
  .meta({ id: 'AdminHelpArticles' });

export const legalPageEditSchema = z
  .object({ title: z.string().trim().min(3).max(120), markdown: z.string().min(20).max(200_000) })
  .meta({ id: 'LegalPageEdit' });

/** A destination landing page's fields (plan §3 `destinations`); empty text removes an optional one. */
const destinationFields = {
  city: z
    .string()
    .trim()
    .min(2, { error: 'Enter the name' })
    .max(60, { error: 'Use 60 characters or fewer' }),
  maoriName: z
    .string()
    .trim()
    .max(80, { error: 'Use 80 characters or fewer' })
    .meta({ description: 'The te reo Māori name; empty removes it' }),
  region: z.enum(NZ_REGIONS),
  tagline: z
    .string()
    .trim()
    .max(160, { error: 'Use 160 characters or fewer' })
    .meta({ description: 'Empty removes it' }),
  intro: z
    .string()
    .trim()
    .min(20, { error: 'Write at least 20 characters' })
    .max(5000, { error: 'Use 5,000 characters or fewer' }),
  heroImage: z
    .string()
    .trim()
    .max(500, { error: 'Use 500 characters or fewer' })
    .refine((value) => value === '' || isLinkAddress(value), {
      error: 'Use a full address starting with https://, or a path on this website starting with /',
    })
    .meta({ description: 'The picture’s address; empty removes it' }),
  lat: z
    .number()
    .min(-48, { error: 'Enter a latitude in New Zealand, between -48 and -34' })
    .max(-34, { error: 'Enter a latitude in New Zealand, between -48 and -34' }),
  lng: z
    .number()
    .min(166, { error: 'Enter a longitude in New Zealand, between 166 and 179' })
    .max(179, { error: 'Enter a longitude in New Zealand, between 166 and 179' }),
  airports: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, { error: 'Use 3-letter airport codes, like AKL' }),
    )
    .max(5, { error: 'Up to 5 airports' })
    .meta({ description: 'IATA codes of airports in the place list' }),
  featured: z.boolean(),
  order: z.number().int().min(0).max(1000),
  published: z.boolean(),
};

export const destinationCreateSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(60, { error: 'Use 60 characters or fewer' })
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'Lowercase words joined by dashes, like bay-of-islands' })
      .meta({ description: 'The page’s address, /rental/{slug}. It can’t change later.' }),
    city: destinationFields.city,
    maoriName: destinationFields.maoriName.optional(),
    region: destinationFields.region,
    tagline: destinationFields.tagline.optional(),
    intro: destinationFields.intro,
    heroImage: destinationFields.heroImage.optional(),
    lat: destinationFields.lat,
    lng: destinationFields.lng,
    airports: destinationFields.airports.default([]),
    featured: destinationFields.featured.default(false),
    order: destinationFields.order.default(0),
    published: destinationFields.published.default(true),
  })
  .meta({ id: 'DestinationCreate' });

export const destinationEditSchema = z
  .object({
    city: destinationFields.city.optional(),
    maoriName: destinationFields.maoriName.optional(),
    region: destinationFields.region.optional(),
    tagline: destinationFields.tagline.optional(),
    intro: destinationFields.intro.optional(),
    heroImage: destinationFields.heroImage.optional(),
    lat: destinationFields.lat.optional(),
    lng: destinationFields.lng.optional(),
    airports: destinationFields.airports.optional(),
    featured: destinationFields.featured.optional(),
    order: destinationFields.order.optional(),
    published: destinationFields.published
      .optional()
      .meta({ description: 'False: off the homepage, a 404 page and out of the sitemap' }),
  })
  .refine((value) => (value.lat === undefined) === (value.lng === undefined), {
    error: 'Give the latitude and longitude together',
    path: ['lng'],
  })
  .meta({ id: 'DestinationEdit' });

export const faqInputSchema = z
  .object({
    question: z.string().trim().min(5).max(300),
    answer: z.string().trim().min(5).max(5000),
    category: z.string().trim().min(2).max(60),
    audience: z.enum(['GUEST', 'HOST', 'ALL']),
    showOnHome: z.boolean().default(false),
    order: z.number().int().min(0).max(1000).default(0),
  })
  .meta({ id: 'FaqInput' });

export const helpArticleInputSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'Lowercase words joined by dashes' }),
    title: z.string().trim().min(3).max(160),
    body: z.string().min(20).max(50_000),
    category: z.string().trim().min(2).max(60),
    audience: z.enum(['GUEST', 'HOST', 'ALL']),
    published: z.boolean().default(true),
    order: z.number().int().min(0).max(1000).default(0),
  })
  .meta({ id: 'HelpArticleInput' });

export const adminHomeHeroSchema = z
  .object({
    hero: homeHeroSchema,
    saved: z.boolean().meta({ description: 'False while the homepage shows its original text' }),
  })
  .meta({ id: 'AdminHomeHero' });

export const adminSiteFooterSchema = z
  .object({
    footer: siteFooterSchema,
    saved: z.boolean().meta({ description: 'False while the footer shows its original links' }),
  })
  .meta({ id: 'AdminSiteFooter' });

export const featuredReviewsSchema = z
  .object({ reviewIds: z.array(z.string().regex(/^[0-9a-f]{24}$/)).max(6) })
  .meta({ id: 'FeaturedReviewsInput' });

const adminReviewChoiceSchema = z
  .object({
    id: z.string(),
    authorName: z.string().meta({ description: 'The Guest’s first name, as the homepage shows it' }),
    overall: z.number().int(),
    body: z.string(),
    vehicleTitle: z.string(),
    city: z.string().optional(),
    createdAt: iso,
    shown: z.boolean().meta({
      description: 'Published and not hidden: a picked review that isn’t is left off the homepage',
    }),
  })
  .meta({ id: 'AdminReviewChoice' });

export const adminFeaturedReviewsSchema = z
  .object({
    reviewIds: z.array(z.string()),
    reviews: z.array(adminReviewChoiceSchema),
    homepageThreshold: z
      .number()
      .int()
      .meta({ description: 'Published reviews needed before the homepage shows any (settings)' }),
    publishedCount: z.number().int(),
  })
  .meta({ id: 'AdminFeaturedReviews' });

export const reviewChoicesResponseSchema = z
  .object({ reviews: z.array(adminReviewChoiceSchema) })
  .meta({ id: 'AdminReviewChoices' });

// Reports, audit log and jobs --------------------------------------------------------------------------------

export const reportRangeSchema = z.object({
  from: z.iso.date().meta({ description: 'First NZ day, 2026-10-01' }),
  to: z.iso.date().meta({ description: 'Last NZ day, inclusive' }),
});

export const exportQuerySchema = reportRangeSchema.extend({
  type: z.enum(['bookings', 'payments', 'refunds', 'payouts', 'cancellations', 'gst', 'revenue']),
});

export const platformReportSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    bookings: z.object({
      created: z.number().int(),
      confirmed: z.number().int(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      byStatus: z.record(z.string(), z.number().int()),
    }),
    money: z.object({
      grossBookingsCents: cents.meta({ description: 'Paid for trips starting in the range, GST included' }),
      refundsCents: cents.meta({ description: 'Sent to Guests in the range' }),
      platformFeesCents: cents.meta({
        description:
          'Service fees and commission, the platform’s share of cancellation fees kept and the commission on extra charges (fees.totalCents)',
      }),
      hostPayoutsPaidCents: cents,
      extraChargesCents: cents.meta({ description: 'Paid in the range, GST included' }),
      cancellationFeesKeptCents: cents,
      gstCollectedCents: cents.meta({ description: 'Net of refunds (gst.collectedCents)' }),
      gstOnPlatformFeesCents: cents,
    }),
    fees: z.object({
      serviceFeesCents: cents.meta({ description: 'On trips starting in the range' }),
      hostCommissionCents: cents.meta({ description: 'On trips starting in the range' }),
      cancellationFeesShareCents: cents.meta({
        description: 'The platform’s share of the fees kept from bookings cancelled in the range',
      }),
      extraChargeCommissionCents: cents.meta({ description: 'On extra charges paid in the range' }),
      totalCents: cents,
    }),
    gst: z.object({
      ratePct: z.number().meta({ description: 'From settings (plan §5: 15 %, provisional)' }),
      inTripsCents: cents,
      inExtraChargesCents: cents,
      inCancellationFeesCents: cents.meta({
        description: 'In the fees kept from bookings cancelled in the range',
      }),
      givenBackCents: cents.meta({
        description:
          'In refunds sent in the range of money counted here. A cancellation’s own refund is already left out of the fee kept.',
      }),
      collectedCents: cents.meta({ description: 'Trips, extra charges and fees kept, less refunds' }),
      onPlatformFeesCents: cents,
    }),
  })
  .meta({ id: 'PlatformReport' });

export const auditQuerySchema = z.object({
  actor: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  entity: z.string().max(40).optional(),
  entityId: z.string().max(100).optional(),
  action: z.string().max(80).optional(),
  page,
});

export const auditEntrySchema = z
  .object({
    id: z.string(),
    actor: z.object({ id: z.string(), name: z.string() }).optional(),
    action: z.string(),
    entity: z.string(),
    entityId: z.string().optional(),
    before: z.unknown().optional(),
    after: z.unknown().optional(),
    ip: z.string().optional(),
    createdAt: iso,
  })
  .meta({ id: 'AuditEntry' });

export const auditResponseSchema = z
  .object({ entries: z.array(auditEntrySchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AuditLog' });

export const jobQuerySchema = z.object({
  status: z.enum(['FAILED', 'QUEUED', 'RUNNING']).default('FAILED'),
  page,
});

export const adminJobSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    lastError: z.string().optional(),
    refId: z.string().optional(),
    runAt: iso,
    finishedAt: iso.optional(),
  })
  .meta({ id: 'AdminJob' });

export const adminJobsResponseSchema = z
  .object({ jobs: z.array(adminJobSchema), total: z.number().int(), page: z.number().int() })
  .meta({ id: 'AdminJobs' });
