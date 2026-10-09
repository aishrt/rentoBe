import { z } from 'zod';
import { NZ_REGIONS } from '../../lib/model-fields.js';
import { BLOCK_REASONS } from '../availability/availability-block.model.js';
import {
  BODY_TYPES,
  DELIVERY_TYPES,
  DOCUMENT_TYPES,
  FUEL_POLICIES,
  FUEL_TYPES,
  PHOTO_QUALITY_FLAGS,
  PHOTO_TYPES,
  TRANSMISSIONS,
  VEHICLE_STATUSES,
  VIN_PATTERN,
} from './vehicle.model.js';

/*
 * Host vehicle onboarding in 6 steps (plan §9, Days 8–11): each step saves a draft with PATCH, so
 * every field is optional here. Limits from platformSettings (seats, doors, prices, discounts) and
 * cross-field rules are checked by the service.
 */

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use a date like 2027-03-31' })
  .meta({ description: 'YYYY-MM-DD' });
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

export const addressWithPointSchema = z
  .object({
    unit: z.string().trim().max(20).optional(),
    streetNumber: z.string().trim().max(20).optional(),
    street: z.string().trim().min(2, { error: 'Enter the street' }).max(120),
    suburb: z.string().trim().max(80).optional(),
    city: z.string().trim().min(2, { error: 'Enter the town or city' }).max(80),
    region: z.enum(NZ_REGIONS, { error: 'Choose a region' }),
    postcode: z.string().regex(/^\d{4}$/, { error: 'NZ postcodes have 4 digits' }),
    lat: z.number().min(-48).max(-33),
    lng: z.number().min(165).max(179.9),
  })
  .meta({ id: 'AddressWithPoint', description: 'A structured NZ address with its coordinates (plan §3)' });

export const deliveryOptionInputSchema = z
  .object({
    id: z.string().optional().meta({ description: 'Keep an existing option (bookings refer to it)' }),
    type: z.enum(DELIVERY_TYPES),
    label: z.string().trim().min(2).max(80).optional(),
    address: addressWithPointSchema.optional().meta({ description: 'PICKUP and CUSTOM: the address' }),
    airportCode: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .optional(),
    feeCents: z.number().int().min(0).max(50_000).default(0),
    radiusKm: z.number().min(1).max(100).optional().meta({ description: 'DELIVERY: how far from the car' }),
    instructions: z.string().trim().max(1000).optional().meta({
      description: 'Shown to the Guest once the booking is confirmed, e.g. where to meet at the airport',
    }),
  })
  .meta({ id: 'DeliveryOptionInput' });

export const vehiclePatchSchema = z
  .object({
    // Step 1: vehicle details.
    regoPlate: z
      .string()
      .transform((plate) => plate.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{1,6}$/, { error: 'Number plates have 1–6 letters and numbers' }))
      .optional(),
    vin: nullable(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(VIN_PATTERN, { error: 'VINs have 17 letters and numbers, without I, O or Q' }),
    ),
    chassisNo: nullable(z.string().trim().toUpperCase().min(5).max(30)),
    make: z.string().trim().min(1).max(40).optional(),
    model: z.string().trim().min(1).max(40).optional(),
    year: z.number().int().min(1950).optional(),
    variant: nullable(z.string().trim().max(60)),
    bodyType: z.enum(BODY_TYPES).optional(),
    fuelType: z.enum(FUEL_TYPES).optional(),
    transmission: z.enum(TRANSMISSIONS).optional(),
    seats: z.number().int().optional(),
    doors: z.number().int().optional(),
    powertrain: nullable(
      z.object({
        engineCc: z.number().int().min(0).max(10_000).optional(),
        cylinders: z.number().int().min(0).max(16).optional(),
        description: z.string().trim().max(80).optional(),
        evRangeKm: z.number().int().min(0).max(1_500).optional(),
        batteryKwh: z.number().min(0).max(250).optional(),
      }),
    ),
    features: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    petFriendly: z.boolean().optional(),
    childSeat: z.boolean().optional(),
    damageNotes: nullable(z.string().trim().max(1000)),
    // Step 2: document dates (the files are uploaded separately).
    regoExpiry: date.optional(),
    wofExpiry: nullable(date),
    cofExpiry: nullable(date),
    rucValidToKm: nullable(z.number().int().min(0).max(2_000_000)),
    ownerIsHost: z.boolean().optional(),
    // Step 4: pricing.
    pricing: z
      .object({
        dailyCents: z.number().int().min(0),
        weeklyDiscountPct: z.number().min(0).max(100).default(0),
        monthlyDiscountPct: z.number().min(0).max(100).default(0),
        extraKmCents: z.number().int().min(0).max(1_000).default(0),
      })
      .optional(),
    kmAllowancePerDay: nullable(z.number().int().min(50).max(2_000)),
    unlimitedKm: z.boolean().optional(),
    fuelPolicy: z.enum(FUEL_POLICIES).optional(),
    // Steps 4 and 5: trip rules.
    rules: z
      .object({
        minDays: z.number().int().min(1).max(90).optional(),
        maxDays: z.number().int().min(1).max(365).optional(),
        minNoticeHours: z
          .number()
          .int()
          .min(0)
          .max(24 * 14)
          .optional(),
        bufferHours: z.number().int().min(0).max(72).optional(),
        instantBook: z.boolean().optional(),
        cancellationTier: z.string().optional(),
      })
      .optional(),
    // Step 6: pickup and delivery.
    deliveryOptions: z.array(deliveryOptionInputSchema).max(10).optional(),
    onboardingStep: z.number().int().min(1).max(6).optional(),
  })
  .meta({ id: 'VehiclePatch' });
export type VehiclePatch = z.infer<typeof vehiclePatchSchema>;

export const photoAttachSchema = z
  .object({
    type: z.enum(PHOTO_TYPES),
    /** The upload target's `key`. */
    upload: z.string().min(1).max(300),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    qualityFlag: z.enum(PHOTO_QUALITY_FLAGS).exclude(['ADMIN_FLAGGED']).default('OK').meta({
      description:
        "The browser's checks: LOW_RES, DARK or BLURRY are shown to support staff (plan §9, Days 8–11)",
    }),
  })
  .meta({ id: 'PhotoAttach' });

export const documentAttachSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    upload: z.string().min(1).max(300),
    expiry: date.optional(),
  })
  .meta({ id: 'DocumentAttach' });

export const checklistSchema = z
  .object({
    complete: z.boolean(),
    missing: z.array(z.object({ step: z.number().int(), field: z.string(), message: z.string() })),
    flags: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .meta({ id: 'ListingChecklist' });

export const hostVehicleSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(VEHICLE_STATUSES),
    waitingForPayouts: z.boolean().meta({
      description: 'Approved, but out of search until the Host finishes payout setup (plan §8.2)',
    }),
    reviewNotes: z.string().optional(),
    onboardingStep: z.number().int(),
    regoPlate: z.string().optional(),
    vin: z.string().optional(),
    chassisNo: z.string().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    year: z.number().int().optional(),
    variant: z.string().optional(),
    bodyType: z.enum(BODY_TYPES).optional(),
    fuelType: z.enum(FUEL_TYPES).optional(),
    transmission: z.enum(TRANSMISSIONS).optional(),
    seats: z.number().int().optional(),
    doors: z.number().int().optional(),
    powertrain: z
      .object({
        engineCc: z.number().optional(),
        cylinders: z.number().optional(),
        description: z.string().optional(),
        evRangeKm: z.number().optional(),
        batteryKwh: z.number().optional(),
      })
      .optional(),
    features: z.array(z.string()),
    petFriendly: z.boolean(),
    childSeat: z.boolean(),
    damageNotes: z.string().optional(),
    regoExpiry: date.optional(),
    wofExpiry: date.optional(),
    cofExpiry: date.optional(),
    rucValidToKm: z.number().optional(),
    ownerIsHost: z.boolean(),
    pricing: z
      .object({
        dailyCents: z.number().int(),
        weeklyDiscountPct: z.number(),
        monthlyDiscountPct: z.number(),
        extraKmCents: z.number().int(),
      })
      .optional(),
    kmAllowancePerDay: z.number().optional(),
    unlimitedKm: z.boolean(),
    fuelPolicy: z.enum(FUEL_POLICIES),
    rules: z.object({
      minDays: z.number().int(),
      maxDays: z.number().int(),
      minNoticeHours: z.number(),
      bufferHours: z.number(),
      instantBook: z.boolean(),
      cancellationTier: z.string().optional(),
    }),
    photos: z.array(
      z.object({
        id: z.string(),
        type: z.enum(PHOTO_TYPES),
        url: z.string(),
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
        qualityFlag: z.enum(PHOTO_QUALITY_FLAGS),
      }),
    ),
    documents: z.array(
      z.object({
        id: z.string(),
        type: z.enum(DOCUMENT_TYPES),
        status: z.enum(['PENDING', 'VERIFIED', 'REJECTED']),
        expiry: date.optional(),
        link: z.string().meta({ description: 'A short-lived link to open the private file' }),
      }),
    ),
    deliveryOptions: z.array(
      z.object({
        id: z.string(),
        type: z.enum(DELIVERY_TYPES),
        label: z.string(),
        address: addressWithPointSchema.optional(),
        airportCode: z.string().optional(),
        feeCents: z.number().int(),
        radiusKm: z.number().optional(),
        instructions: z.string().optional(),
      }),
    ),
    recurringRules: z.array(
      z.object({
        id: z.string(),
        daysOfWeek: z.array(z.number().int()),
        startTime: z.string(),
        endTime: z.string(),
      }),
    ),
    suburb: z.string().optional(),
    city: z.string().optional(),
    rating: z.object({ avg: z.number(), count: z.number().int() }),
    tripCount: z.number().int(),
    checklist: checklistSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'HostVehicle' });
export type HostVehicleView = z.infer<typeof hostVehicleSchema>;

export const hostVehicleResponseSchema = z
  .object({ vehicle: hostVehicleSchema })
  .meta({ id: 'HostVehicleResponse' });

export const hostVehicleSummarySchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    status: z.enum(VEHICLE_STATUSES),
    waitingForPayouts: z.boolean().meta({
      description: 'Approved, but out of search until the Host finishes payout setup (plan §8.2)',
    }),
    onboardingStep: z.number().int(),
    photo: z.string().nullable(),
    missingCount: z.number().int(),
    pendingChanges: z.boolean().meta({ description: 'New photos or documents waiting for support staff' }),
    dailyCents: z.number().int().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'HostVehicleSummary' });

export const hostVehiclesResponseSchema = z
  .object({ vehicles: z.array(hostVehicleSummarySchema) })
  .meta({ id: 'HostVehicles' });

export const blockInputSchema = z
  .object({
    start: z
      .string()
      .meta({ description: '"2026-10-12T10:00" in NZ time, or a date "2026-10-12" for the whole day' }),
    end: z.string().meta({ description: 'Exclusive; a date means the start of that day' }),
    note: z.string().trim().max(200).optional(),
  })
  .meta({ id: 'BlockInput' });

export const recurringRulesInputSchema = z
  .object({
    rules: z
      .array(
        z.object({
          daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1, { error: 'Choose at least one day' }),
          startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:mm' }),
          endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'Use HH:mm' }),
        }),
      )
      .max(14),
  })
  .meta({ id: 'RecurringRulesInput' });

export const calendarBlockSchema = z
  .object({
    id: z.string(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    reason: z.enum(BLOCK_REASONS),
    note: z.string().optional(),
    holdExpiresAt: z.iso.datetime().optional(),
    booking: z
      .object({
        id: z.string(),
        ref: z.string(),
        status: z.string(),
        guestFirstName: z.string(),
        toAnswer: z.boolean().meta({
          description:
            'A request the Host still has to accept or decline. False while it only waits for the Guest’s verification',
        }),
      })
      .optional()
      .meta({ description: 'BOOKED and HOLD blocks: the booking ("Request pending" while it waits)' }),
  })
  .meta({ id: 'CalendarBlock' });

export const calendarResponseSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    blocks: z.array(calendarBlockSchema),
    rules: z.object({ minNoticeHours: z.number(), bufferHours: z.number() }),
  })
  .meta({ id: 'HostCalendar' });

/** The all-cars calendar answers up to two months at a time: the website asks for a month, or two weeks. */
export const MAX_ALL_CARS_CALENDAR_DAYS = 62;
const DAY_MS = 24 * 60 * 60 * 1000;

export const allCarsCalendarQuerySchema = z
  .object({
    from: z.iso.date().meta({ description: 'The first NZ day, 2026-10-01' }),
    to: z.iso.date().meta({ description: 'The NZ day after the last one (exclusive), 2026-11-01' }),
  })
  .refine(({ from, to }) => to > from, { error: 'Choose an end after the start', path: ['to'] })
  .refine(({ from, to }) => Date.parse(to) - Date.parse(from) <= MAX_ALL_CARS_CALENDAR_DAYS * DAY_MS, {
    error: `Choose up to ${MAX_ALL_CARS_CALENDAR_DAYS} days`,
    path: ['to'],
  });

export const allCarsCalendarSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    vehicles: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          photo: z.string().nullable(),
          status: z.enum(VEHICLE_STATUSES),
          blocks: z.array(calendarBlockSchema).meta({ description: 'As on the car’s own calendar' }),
        })
        .meta({ id: 'CalendarCar' }),
    ),
  })
  .meta({ id: 'AllCarsCalendar' });

export const recurringResultSchema = z
  .object({
    blocks: z.number().int(),
    skipped: z
      .array(z.object({ start: z.iso.datetime(), end: z.iso.datetime() }))
      .meta({ description: 'Times left open because a booking or request is there' }),
  })
  .meta({ id: 'RecurringResult' });
