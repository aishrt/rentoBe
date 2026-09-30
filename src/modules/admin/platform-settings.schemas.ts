import { z } from 'zod';
import { LICENCE_CLASSES } from '../users/user.model.js';
import { BODY_TYPES, DOCUMENT_TYPES, PHOTO_TYPES } from '../vehicles/vehicle.model.js';

const percent = z.number().min(0).max(100);
const wholeCents = z.number().int().min(0);
const count = z.number().int().min(0);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:mm' });

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
});
export type ProtectionPlan = z.infer<typeof protectionPlanSchema>;

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
});
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;
