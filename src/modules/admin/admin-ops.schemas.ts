import { z } from 'zod';
import { BOOKING_STATUSES, EXTRA_CHARGE_STATUSES, EXTRA_CHARGE_TYPES } from '../bookings/booking.model.js';
import { bookingViewSchema } from '../bookings/bookings.schemas.js';
import { legalPageSchema } from '../cms/content.schemas.js';
import { INCIDENT_STATUSES, INCIDENT_TYPES } from '../incidents/incident.model.js';
import { PAYMENT_STATUSES, PAYMENT_TYPES } from '../payments/payment.model.js';
import { PAYOUT_HOLD_REASONS, PAYOUT_STATUSES, PAYOUT_TYPES } from '../payouts/payout.model.js';
import { REPORT_STATUSES, REPORT_TARGET_TYPES } from '../moderation/report.model.js';
import { moderationReviewSchema } from '../reviews/reviews.schemas.js';
import { TICKET_CATEGORIES, TICKET_STATUSES } from '../support/support-ticket.model.js';
import { HOST_STATUSES, ROLES, USER_STATUSES, VERIFICATION_STATUSES } from '../users/user.model.js';
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

const bookingRowSchema = z
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
      })
      .nullable(),
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
    amountCents: z.number().int().min(1, { error: 'Enter an amount' }),
    reason,
    fundedBy: z.enum(['PLATFORM', 'HOST']).meta({
      description:
        'PLATFORM: a goodwill refund. HOST: rental the Host would otherwise get (plan §8.1, item 15).',
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
    bookingRef: z
      .string()
      .optional()
      .meta({ description: 'A reported message’s booking, to open its thread' }),
    // A reported review, whole, so staff can read it and hide it from the report.
    review: moderationReviewSchema.optional(),
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
    featured: z.boolean(),
    order: z.number().int(),
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

export const destinationEditSchema = z
  .object({
    tagline: z.string().trim().max(160).optional(),
    intro: z.string().trim().min(20).max(5000).optional(),
    heroImage: z.url().optional(),
    featured: z.boolean().optional(),
    order: z.number().int().min(0).max(1000).optional(),
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

// Reports, audit log and jobs --------------------------------------------------------------------------------

export const reportRangeSchema = z.object({
  from: z.iso.date().meta({ description: 'First NZ day, 2026-10-01' }),
  to: z.iso.date().meta({ description: 'Last NZ day, inclusive' }),
});

export const exportQuerySchema = reportRangeSchema.extend({
  type: z.enum(['bookings', 'payments', 'refunds', 'payouts', 'cancellations', 'gst']),
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
      refundsCents: cents,
      platformFeesCents: cents.meta({ description: 'Service fees and commission' }),
      hostPayoutsPaidCents: cents,
      extraChargesCents: cents,
      cancellationFeesKeptCents: cents,
      gstCollectedCents: cents,
      gstOnPlatformFeesCents: cents,
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
