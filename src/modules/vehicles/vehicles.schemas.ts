import { z } from 'zod';
import { cancellationTierSchema } from '../admin/platform-settings.schemas.js';
import { nzAddressInputSchema, ratingSchema, vehicleCardSchema } from '../search/search.schemas.js';
import {
  BODY_TYPES,
  DELIVERY_TYPES,
  FUEL_POLICIES,
  FUEL_TYPES,
  PHOTO_TYPES,
  TRANSMISSIONS,
} from './vehicle.model.js';

/*
 * The public listing (plan §9, Days 8–10) and its price quote (Days 10–12). No number plate, no
 * exact address and no pending photo ever appear here (plan §3, location and contact privacy).
 */

export const complianceItemSchema = z.object({
  status: z.enum(['CURRENT', 'EXPIRED', 'NOT_RECORDED']),
  expiresMonth: z.string().optional().meta({ description: 'YYYY-MM' }),
});

export const complianceSchema = z
  .object({
    rego: complianceItemSchema,
    inspection: complianceItemSchema.extend({
      kind: z.enum(['WOF', 'COF']).meta({ description: 'A Warrant of Fitness, or a Certificate of Fitness' }),
    }),
    ruc: z.object({
      required: z.boolean().meta({ description: 'Diesel, EV and plug-in hybrid cars pay Road User Charges' }),
      recorded: z.boolean(),
    }),
  })
  .meta({ id: 'VehicleCompliance' });

export const publicHostSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    avatarUrl: z.string().optional(),
    rating: ratingSchema,
    tripCount: z.number().int(),
    responseRate: z.number().optional().meta({ description: 'Share of booking requests answered, 0–100' }),
    verified: z.boolean().meta({ description: 'Identity verified' }),
    joinedYear: z.number().int(),
    bio: z.string().optional(),
  })
  .meta({ id: 'PublicHost' });

export const deliveryOptionSummarySchema = z
  .object({
    id: z.string(),
    type: z.enum(DELIVERY_TYPES),
    label: z.string(),
    feeCents: z.number().int(),
    airportCode: z.string().optional(),
    radiusKm: z.number().optional().meta({ description: 'DELIVERY: how far from the car it delivers' }),
    area: z.string().optional().meta({ description: 'PICKUP and CUSTOM: the suburb and city only' }),
  })
  .meta({ id: 'DeliveryOptionSummary' });

export const protectionPlanSummarySchema = z
  .object({
    code: z.string(),
    name: z.string(),
    dailyPriceCents: z.number().int(),
    excessCents: z.number().int(),
    coverSummary: z.string(),
    mandatory: z.boolean(),
  })
  .meta({ id: 'ProtectionPlanSummary' });

export const vehicleDetailSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    make: z.string(),
    model: z.string(),
    year: z.number().int(),
    variant: z.string().optional(),
    bodyType: z.enum(BODY_TYPES),
    fuelType: z.enum(FUEL_TYPES),
    transmission: z.enum(TRANSMISSIONS),
    seats: z.number().int(),
    doors: z.number().int(),
    features: z.array(z.string()),
    powertrain: z
      .object({
        engineCc: z.number().optional(),
        cylinders: z.number().optional(),
        description: z.string().optional(),
        evRangeKm: z.number().optional(),
        batteryKwh: z.number().optional(),
      })
      .nullable(),
    fuelPolicy: z.enum(FUEL_POLICIES),
    kmAllowancePerDay: z.number().nullable(),
    unlimitedKm: z.boolean(),
    extraKmCents: z.number().int(),
    petFriendly: z.boolean(),
    childSeat: z.boolean(),
    pricing: z.object({
      dailyCents: z.number().int(),
      weeklyDiscountPct: z.number(),
      monthlyDiscountPct: z.number(),
    }),
    rules: z.object({
      minDays: z.number().int(),
      maxDays: z.number().int(),
      minNoticeHours: z.number(),
      bufferHours: z.number(),
      instantBook: z.boolean(),
    }),
    cancellationTier: cancellationTierSchema,
    photos: z.array(
      z.object({ id: z.string(), type: z.enum(PHOTO_TYPES), url: z.string(), alt: z.string() }),
    ),
    compliance: complianceSchema,
    location: z.object({
      suburb: z.string().optional(),
      city: z.string().optional(),
      region: z.string().optional(),
      approx: z
        .object({ lat: z.number(), lng: z.number(), radiusM: z.number() })
        .nullable()
        .meta({ description: 'A circle that contains the car, for the map; never its address' }),
      mapUrl: z.string().nullable().meta({
        description:
          'The area map image (GET /vehicles/{id}/area-map), served by this API so no Google key reaches the browser; null when Google isn’t set up',
      }),
    }),
    deliveryOptions: z.array(deliveryOptionSummarySchema),
    protectionPlans: z.array(protectionPlanSummarySchema),
    rating: ratingSchema,
    tripCount: z.number().int(),
    host: publicHostSchema,
  })
  .meta({ id: 'VehicleDetail' });
export type VehicleDetail = z.infer<typeof vehicleDetailSchema>;

export const featuredVehiclesSchema = z
  .object({ vehicles: z.array(vehicleCardSchema) })
  .meta({ id: 'FeaturedVehicles' });

export const availabilityQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const availabilityResponseSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    busy: z
      .array(z.object({ start: z.iso.datetime(), end: z.iso.datetime() }))
      .meta({ description: 'When the car is taken, merged; never why' }),
    minNoticeHours: z.number(),
    bufferHours: z.number(),
    minDays: z.number().int(),
    maxDays: z.number().int(),
  })
  .meta({ id: 'VehicleAvailability' });

export const vehicleReviewSchema = z
  .object({
    id: z.string(),
    author: z.object({
      id: z.string().meta({ description: 'Who wrote it, so readers can report a review but not their own' }),
      firstName: z.string(),
      avatarUrl: z.string().optional(),
    }),
    overall: z.number().int(),
    body: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'VehicleReview' });

export const vehicleReviewsResponseSchema = z
  .object({
    reviews: z.array(vehicleReviewSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    rating: ratingSchema,
    categories: z
      .object({
        cleanliness: z.number().nullable(),
        communication: z.number().nullable(),
        pickupReturn: z.number().nullable(),
      })
      .meta({ description: 'Average stars in each category' }),
  })
  .meta({ id: 'VehicleReviews' });

export const deliveryAddressSchema = nzAddressInputSchema
  .extend({ lat: z.number().min(-48).max(-33), lng: z.number().min(165).max(179.9) })
  .meta({ id: 'DeliveryAddress', description: 'Where to deliver the car, with its coordinates' });

export const quoteRequestSchema = z
  .object({
    start: z.string().meta({ description: '"2026-10-12T10:00" in NZ time, or ISO 8601 with an offset' }),
    end: z.string(),
    pickupOptionId: z.string().optional().meta({ description: 'Left out: collect from the Host' }),
    returnOptionId: z.string().optional().meta({ description: 'Left out: the same as pick-up' }),
    deliveryAddress: deliveryAddressSchema.optional().meta({ description: 'Needed for a DELIVERY option' }),
    protectionPlanCode: z.string().optional().meta({ description: 'Left out: the mandatory plan' }),
  })
  .meta({ id: 'QuoteRequest' });
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const lineItemSchema = z
  .object({
    code: z.string(),
    label: z.string(),
    amountCents: z.number().int().meta({ description: 'Negative for a discount' }),
    gstCents: z.number().int(),
    mandatory: z.boolean(),
  })
  .meta({ id: 'LineItem' });

export const TRIP_PROBLEM_CODES = [
  'DATES_UNAVAILABLE',
  'NOTICE_TOO_SHORT',
  'TRIP_TOO_SHORT',
  'TRIP_TOO_LONG',
  'DOCUMENTS_EXPIRE',
  'OPTION_NOT_FOUND',
  'ADDRESS_NEEDED',
  'OUTSIDE_DELIVERY_AREA',
  'PLAN_NOT_FOUND',
] as const;

export const tripProblemSchema = z
  .object({
    code: z.enum(TRIP_PROBLEM_CODES),
    message: z.string(),
    field: z.string().optional(),
  })
  .meta({ id: 'TripProblem' });
export type TripProblem = z.infer<typeof tripProblemSchema>;

export const guestPriceSchema = z
  .object({
    subtotalCents: z.number().int().meta({ description: 'Rental, after any discount' }),
    deliveryCents: z.number().int(),
    serviceFeeCents: z.number().int(),
    protectionCents: z.number().int(),
    gstCents: z.number().int().meta({ description: 'GST included in the total' }),
    totalCents: z.number().int(),
    mandatoryCents: z.number().int(),
    optionalCents: z.number().int(),
  })
  .meta({ id: 'GuestPrice' });

export const quoteSchema = z
  .object({
    available: z.boolean().meta({ description: 'False when there are problems; the price is still shown' }),
    problems: z.array(tripProblemSchema),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    days: z.number().int(),
    lineItems: z.array(lineItemSchema),
    price: guestPriceSchema,
    protectionPlan: protectionPlanSummarySchema.nullable(),
    pickup: deliveryOptionSummarySchema,
    dropoff: deliveryOptionSummarySchema,
    instantBook: z.boolean(),
    cancellationTier: cancellationTierSchema,
  })
  .meta({ id: 'Quote' });
export type Quote = z.infer<typeof quoteSchema>;
