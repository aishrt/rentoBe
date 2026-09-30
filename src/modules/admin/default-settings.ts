import type { PlatformSettings } from './platform-settings.schemas.js';

/**
 * Launch defaults for platformSettings (plan §9, Day 1). They're placeholders until the client decides
 * (plan §16): fees (item 2), cancellation tiers and fees (item 3), eligibility and verification (item 5),
 * protection plans (item 9), review rules and windows (item 10) and retention periods (item 11).
 * Admins change the live values in platformSettings; changing a default here only affects settings that
 * were never saved.
 */
export const DEFAULT_SETTINGS: PlatformSettings = {
  fees: {
    guestServiceFeePct: 10,
    hostCommissionPct: 20,
    gstRatePct: 15,
    platformPaysCardFees: true,
  },
  cancellation: {
    tiers: [
      {
        code: 'FLEXIBLE',
        name: 'Flexible',
        summary: 'Full refund up to 24 hours before pickup, then 50%.',
        refunds: [
          { minHoursBefore: 24, refundPct: 100 },
          { minHoursBefore: 0, refundPct: 50 },
        ],
      },
      {
        code: 'MODERATE',
        name: 'Moderate',
        summary: 'Full refund up to 5 days before pickup, 50% up to 24 hours before, then no refund.',
        refunds: [
          { minHoursBefore: 120, refundPct: 100 },
          { minHoursBefore: 24, refundPct: 50 },
          { minHoursBefore: 0, refundPct: 0 },
        ],
      },
      {
        code: 'STRICT',
        name: 'Strict',
        summary: 'Full refund up to 14 days before pickup, 50% up to 7 days before, then no refund.',
        refunds: [
          { minHoursBefore: 336, refundPct: 100 },
          { minHoursBefore: 168, refundPct: 50 },
          { minHoursBefore: 0, refundPct: 0 },
        ],
      },
    ],
    hostSelectableTiers: ['FLEXIBLE', 'MODERATE', 'STRICT'],
    defaultTier: 'MODERATE',
    // $0 until the client decides (plan §8.1, item 10).
    hostCancellationFeeCents: 0,
    // The kept rental is shared like any rental: the Host gets it less commission (plan §5).
    guestCancellationHostSharePct: 100,
    // No refund for unused days on an early return (plan §8.2).
    refundUnusedDaysOnEarlyReturn: false,
  },
  protectionPlans: [
    {
      code: 'BASIC',
      name: 'Basic',
      dailyPriceCents: 1500,
      excessCents: 300_000,
      coverSummary: 'Damage and theft cover with a $3,000 excess.',
      mandatory: true,
    },
    {
      code: 'STANDARD',
      name: 'Standard',
      dailyPriceCents: 2900,
      excessCents: 150_000,
      coverSummary: 'Damage and theft cover with a $1,500 excess.',
      mandatory: false,
    },
    {
      code: 'PREMIUM',
      name: 'Premium',
      dailyPriceCents: 4500,
      excessCents: 50_000,
      coverSummary: 'Damage and theft cover with a $500 excess.',
      mandatory: false,
    },
  ],
  eligibility: {
    minAge: 21,
    minYearsLicensed: 1,
    acceptedLicenceClasses: ['NZ_FULL', 'OVERSEAS'],
    overseasNeedsEnglishProof: true,
  },
  verification: {
    identityBeforeFirstBooking: true,
    identityForHosts: true,
    phoneAtCheckout: true,
    emailBeforeTripStart: true,
  },
  vehicles: {
    requiredDocuments: ['REGO', 'WOF', 'INSURANCE'],
    requiredPhotoAngles: ['FRONT', 'REAR', 'DRIVER', 'PASSENGER', 'INTERIOR', 'DASH', 'BOOT', 'TYRES'],
    // One of the two for every car (plan §16, item 13).
    vinOrChassisRequired: true,
    minPhotoWidthPx: 1200,
    minPhotoHeightPx: 800,
    seats: { min: 2, max: 12 },
    doors: { min: 2, max: 5 },
    dailyPriceCents: { min: 2_000, max: 200_000 },
    maxDiscountPct: 50,
  },
  reviews: {
    windowDays: 14,
    revealTogether: true,
    homepageThreshold: 10,
  },
  trips: {
    lateReturnGraceMinutes: 30,
    damageReportWindowHours: 48,
    threadReadOnlyDays: 30,
  },
  search: {
    maxTripDays: 90,
    radiusKm: { min: 5, default: 25, max: 300 },
  },
  retention: {
    financialRecordsYears: 7,
    idImagesDays: 90,
    tripRecordsYears: 2,
    auditLogYears: 7,
  },
  risk: {
    failedPaymentsPerDay: 3,
    bookingsPerDay: 5,
    reportsBeforeFlag: 3,
    hostCancellationsPer90Days: 3,
  },
  sms: {
    quietHoursStart: '21:00',
    quietHoursEnd: '07:00',
  },
  // Placeholders until the client supplies typical prices and booked days (plan §16, item 18).
  hostEstimator: {
    bookedDaysPerMonth: 10,
    dailyCentsByBodyType: {
      HATCHBACK: 6_000,
      SEDAN: 7_000,
      WAGON: 7_500,
      SUV: 9_500,
      UTE: 10_000,
      VAN: 11_000,
      PEOPLE_MOVER: 11_000,
      COUPE: 12_000,
      CONVERTIBLE: 13_000,
    },
  },
  business: {
    legalName: 'Rento Vroom',
    // Shown on receipts once the client is GST-registered (plan §16, item 7).
    gstNumber: '',
    supportEmail: 'rentovroom@gmail.com',
  },
};
