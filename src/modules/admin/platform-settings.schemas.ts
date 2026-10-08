import { z } from 'zod';
import { LICENCE_CLASSES } from '../users/user.model.js';
import { BODY_TYPES, DOCUMENT_TYPES, PHOTO_TYPES } from '../vehicles/vehicle.model.js';

const percent = z.number().min(0).max(100);
const wholeCents = z.number().int().min(0);
const count = z.number().int().min(0);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:mm' });
/** A phone number to show, or empty for none yet. */
const phone = z
  .string()
  .trim()
  .regex(/^(\+?[\d ()-]{6,20})?$/, { error: 'Enter a phone number, like 0800 123 456' });

const range = (bound: z.ZodNumber) =>
  z
    .object({ min: bound, max: bound })
    .refine((value) => value.min <= value.max, { error: 'min must not be more than max', path: ['min'] });

/**
 * A cancellation tier. When the Guest cancels, the first rule whose `minHoursBefore` is met (checked from
 * the earliest) sets how much of the rental is refunded (plan §5; the policy engine is built on Days 13–14).
 */
export const cancellationTierSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z_]*$/, { error: 'Use capitals and underscores' }),
  name: z.string().min(1),
  summary: z.string().min(1),
  refunds: z.array(z.object({ minHoursBefore: count, refundPct: percent })).min(1),
});
export type CancellationTier = z.infer<typeof cancellationTierSchema>;

export const protectionPlanSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z_]*$/, { error: 'Use capitals and underscores' }),
  name: z.string().min(1),
  dailyPriceCents: wholeCents,
  excessCents: wholeCents,
  coverSummary: z.string().min(1),
  /** The plan every booking includes unless the Guest picks another. */
  mandatory: z.boolean(),
  /** The plan's own roadside assistance number, when its insurer gives one; else roadsideAssistance.phone. */
  roadsidePhone: phone.optional().meta({
    description: 'The plan’s own roadside assistance number; empty or missing means roadsideAssistance.phone',
  }),
});
export type ProtectionPlan = z.infer<typeof protectionPlanSchema>;

/**
 * The client's decisions (plan §16), one per group of settings on the staff portal's Platform settings
 * tab. Each is PENDING while the launch default stands in, and CONFIRMED once the client has decided; the
 * values apply either way.
 */
export const DECISION_KEYS = [
  'fees',
  'cancellation',
  'securityDeposit',
  'eligibility',
  'gst',
  'protection',
  'reviewsAndTrips',
  'company',
  'bookingRules',
  'verificationServices',
] as const;
export type DecisionKey = (typeof DECISION_KEYS)[number];

const decisionSchema = z.object({
  status: z.enum(['PENDING', 'CONFIRMED']),
  /** Who confirmed it and how, e.g. "Client's email, 3 October". */
  note: z.string().trim().max(300, { error: 'Use 300 characters or fewer' }),
});

export const decisionsSchema = z.object(
  Object.fromEntries(DECISION_KEYS.map((key) => [key, decisionSchema])) as Record<
    DecisionKey,
    typeof decisionSchema
  >,
);

/**
 * Everything admins can change without a code change (plan §3 `platformSettings`). The launch defaults are
 * in default-settings.ts until the client's decisions arrive (plan §16).
 */
export const platformSettingsSchema = z.object({
  fees: z.object({
    /** PLATFORM_GUEST_FEE_PCT in plan §5: charged to the Guest on the rental. */
    guestServiceFeePct: percent,
    /** HOST_COMMISSION_PCT in plan §5: kept from the Host's rental. */
    hostCommissionPct: percent,
    gstRatePct: percent,
    /** Stripe's card fees come out of the platform's fees, not the Guest's total (plan §5). */
    platformPaysCardFees: z.boolean(),
  }),
  cancellation: z
    .object({
      tiers: z.array(cancellationTierSchema).min(1),
      /** The tiers a Host may pick for a listing. With one or none, the choice is hidden. */
      hostSelectableTiers: z.array(z.string()),
      defaultTier: z.string(),
      /** Added to the Host's fees owed when they cancel a confirmed booking (plan §8.1, item 10). */
      hostCancellationFeeCents: wholeCents,
      /** How much of a kept Guest cancellation fee goes to the Host, before commission (plan §5). */
      guestCancellationHostSharePct: percent,
      refundUnusedDaysOnEarlyReturn: z.boolean(),
    })
    .refine((value) => value.tiers.some((tier) => tier.code === value.defaultTier), {
      error: 'defaultTier must be one of the tiers',
      path: ['defaultTier'],
    })
    .refine(
      (value) => value.hostSelectableTiers.every((code) => value.tiers.some((tier) => tier.code === code)),
      {
        error: 'hostSelectableTiers must all be tiers',
        path: ['hostSelectableTiers'],
      },
    ),
  protectionPlans: z
    .array(protectionPlanSchema)
    .min(1)
    .refine((plans) => plans.filter((plan) => plan.mandatory).length <= 1, {
      error: 'At most one plan can be mandatory',
    }),
  eligibility: z.object({
    minAge: z.number().int().min(16).max(99),
    minYearsLicensed: z.number().min(0).max(20),
    acceptedLicenceClasses: z.array(z.enum(LICENCE_CLASSES)).min(1),
    /** An overseas licence that isn't in English needs an IDP or an approved translation. */
    overseasNeedsEnglishProof: z.boolean(),
  }),
  verification: z.object({
    identityBeforeFirstBooking: z.boolean(),
    identityForHosts: z.boolean(),
    phoneAtCheckout: z.boolean(),
    emailBeforeTripStart: z.boolean(),
  }),
  vehicles: z.object({
    /** A CoF counts as the WOF for vehicles that need one. */
    requiredDocuments: z.array(z.enum(DOCUMENT_TYPES)),
    requiredPhotoAngles: z.array(z.enum(PHOTO_TYPES)),
    vinOrChassisRequired: z.boolean(),
    minPhotoWidthPx: count,
    minPhotoHeightPx: count,
    seats: range(z.number().int().min(1)),
    doors: range(z.number().int().min(1)),
    dailyPriceCents: range(z.number().int().min(0)),
    maxDiscountPct: percent,
  }),
  reviews: z.object({
    windowDays: z.number().int().min(1),
    /** Both reviews are revealed together, so neither side can retaliate. */
    revealTogether: z.boolean(),
    /** Published reviews needed before the homepage shows the reviews section. */
    homepageThreshold: count,
  }),
  trips: z.object({
    lateReturnGraceMinutes: count,
    damageReportWindowHours: count,
    /** A message thread becomes read-only this long after the trip ends. */
    threadReadOnlyDays: count,
  }),
  search: z.object({
    maxTripDays: z.number().int().min(1),
    radiusKm: z
      .object({ min: z.number().min(1), default: z.number().min(1), max: z.number().min(1) })
      .refine((value) => value.min <= value.default && value.default <= value.max, {
        error: 'default must be between min and max',
        path: ['default'],
      }),
  }),
  /** Proposed periods, to be confirmed by the client's legal adviser (plan §14). */
  retention: z.object({
    financialRecordsYears: count,
    idImagesDays: count,
    tripRecordsYears: count,
    auditLogYears: count,
  }),
  /** When suspicious activity raises a risk flag for admins (plan §14). */
  risk: z.object({
    failedPaymentsPerDay: count,
    bookingsPerDay: count,
    reportsBeforeFlag: count,
    hostCancellationsPer90Days: count,
  }),
  /** Non-urgent SMS in these NZ hours wait until the end (plan §7). */
  sms: z.object({ quietHoursStart: timeOfDay, quietHoursEnd: timeOfDay }),
  /**
   * The Become a Host earnings estimator's assumptions (plan §16, item 18): a typical daily price for
   * each body type and how many days a car is booked in a month. Always shown as an estimate.
   */
  hostEstimator: z.object({
    bookedDaysPerMonth: z.number().int().min(1).max(31),
    dailyCentsByBodyType: z.record(z.enum(BODY_TYPES), wholeCents),
  }),
  /** Who issues receipts, and the GST number they show once the client is registered (plan §8.1, item 18). */
  business: z.object({
    legalName: z.string().min(1),
    gstNumber: z.string().regex(/^(\d{2,3}-\d{3}-\d{3})?$/, { error: 'Use the format 123-456-789' }),
    supportEmail: z.email(),
  }),
  /** Where the client's decisions stand (plan §16); see DECISION_KEYS. */
  decisions: decisionsSchema,
  /**
   * A refundable security deposit held on the Guest's card (plan §16, item 4). 0 means none. Recorded
   * only: the card hold is designed and built once the client decides to have one (plan §5).
   */
  securityDeposit: z.object({ amountCents: wholeCents }),
  /**
   * From the insurance partner (plan §16, item 9). Empty until it arrives; shown with the protection plans.
   * A plan with its own roadsidePhone uses that instead.
   */
  roadsideAssistance: z.object({ phone }),
  /** The logo, trade mark and company name checks (plan §16, item 1). Recorded only. */
  brandChecks: z.object({
    finalLogoSupplied: z.boolean(),
    trademarkSearchDone: z.boolean(),
    companyNameCheckDone: z.boolean(),
  }),
  /**
   * Items the spec leaves open (plan §16, item 13). Recorded only until the features exist: messaging
   * opens with a booking or request, and a booking has one driver.
   */
  bookingRules: z.object({
    enquiriesBeforeBooking: z.boolean(),
    additionalDrivers: z.boolean(),
  }),
  /** The optional NZ services (plan §16, item 15). Recorded only: no provider is connected yet. */
  verificationServices: z.object({
    nzLicenceCheck: z.boolean(),
    plateLookup: z.boolean(),
  }),
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

/**
 * PATCH /admin/settings: the groups to change. Each group sent is complete and replaces the saved one;
 * `decisions` can name only the decisions that change.
 */
export const platformSettingsUpdateSchema = platformSettingsSchema
  .partial()
  .extend({ decisions: decisionsSchema.partial().optional() })
  .strict()
  .meta({ id: 'PlatformSettingsUpdate' });
export type PlatformSettingsUpdate = z.infer<typeof platformSettingsUpdateSchema>;

export const platformSettingsResponseSchema = z
  .object({
    settings: platformSettingsSchema.meta({ id: 'PlatformSettings' }),
    updatedAt: z.iso.datetime().optional().meta({ description: 'When an admin last saved them' }),
    updatedBy: z.string().optional().meta({ description: 'The name of the admin who last saved them' }),
  })
  .meta({ id: 'PlatformSettingsResponse' });
export type PlatformSettingsResponse = z.infer<typeof platformSettingsResponseSchema>;
