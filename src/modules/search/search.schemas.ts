import { z } from 'zod';
import { NZ_REGIONS } from '../../lib/model-fields.js';
import { BODY_TYPES, FUEL_TYPES, TRANSMISSIONS } from '../vehicles/vehicle.model.js';
import { PLACE_TYPES } from './place.model.js';

/*
 * Location autocomplete and search (plan §3, §11). Filters are forgiving: an unknown or malformed
 * value is ignored rather than failing the search (plan §3, Validation rules).
 */

export const placeSuggestionSchema = z
  .object({
    id: z
      .string()
      .meta({ description: '`place:<id>` for our places, `google:<placeId>` for a street address' }),
    type: z.enum([...PLACE_TYPES, 'ADDRESS']),
    name: z.string(),
    label: z
      .string()
      .meta({ description: 'What to show and put in the field, e.g. "Auckland Airport (AKL)"' }),
    secondary: z.string().optional().meta({ description: 'The city or region under the name' }),
    code: z.string().optional().meta({ description: 'Airports: the IATA code' }),
    city: z
      .string()
      .optional()
      .meta({ description: 'The town or city it is in (itself for a city), for addresses' }),
    region: z.enum(NZ_REGIONS).optional().meta({ description: 'The NZ region, for addresses' }),
    lat: z
      .number()
      .optional()
      .meta({ description: 'Our places include coordinates; addresses need GET /places/{id}' }),
    lng: z.number().optional(),
  })
  .meta({ id: 'PlaceSuggestion' });
export type PlaceSuggestion = z.infer<typeof placeSuggestionSchema>;

export const placeSuggestionsResponseSchema = z
  .object({ suggestions: z.array(placeSuggestionSchema) })
  .meta({ id: 'PlaceSuggestions' });

export const nzAddressInputSchema = z
  .object({
    unit: z.string().trim().max(20).optional(),
    streetNumber: z.string().trim().max(20).optional(),
    street: z.string().trim().min(2, { error: 'Enter the street' }).max(120),
    suburb: z.string().trim().max(80).optional(),
    city: z.string().trim().min(2, { error: 'Enter the town or city' }).max(80),
    region: z.enum(NZ_REGIONS, { error: 'Choose a region' }),
    postcode: z.string().regex(/^\d{4}$/, { error: 'NZ postcodes have 4 digits' }),
  })
  .meta({ id: 'NzAddressInput' });

export const placeDetailsSchema = placeSuggestionSchema
  .extend({
    lat: z.number(),
    lng: z.number(),
    address: nzAddressInputSchema
      .optional()
      .meta({ description: 'A street address in the structured NZ format, when every part is known' }),
  })
  .meta({ id: 'PlaceDetails' });
export type PlaceDetails = z.infer<typeof placeDetailsSchema>;

export const SORTS = ['recommended', 'price_asc', 'price_desc', 'rating', 'distance', 'newest'] as const;
export type SearchSort = (typeof SORTS)[number];

/** A query value that may repeat (`type=SUV&type=UTE`) or be comma-separated (`type=SUV,UTE`). */
const list = <Values extends readonly [string, ...string[]]>(values: Values) =>
  z
    .preprocess(
      (value) =>
        (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
          .map((item) => String(item).trim().toUpperCase())
          .filter((item) => (values as readonly string[]).includes(item)),
      z.array(z.enum(values)),
    )
    .optional()
    .catch(undefined);

const flag = z
  .preprocess((value) => (value === 'true' || value === '1' ? true : undefined), z.literal(true).optional())
  .catch(undefined);
const number = (schema: z.ZodNumber) => z.coerce.number().pipe(schema).optional().catch(undefined);
const text = (max: number) => z.string().trim().min(1).max(max).optional().catch(undefined);

export const suggestQuerySchema = z.object({
  q: z.string().max(100).default(''),
  sessionToken: z.string().max(100).optional(),
  /** Our places without Google's street addresses: the Host's place picker types the street itself. */
  oursOnly: flag,
});

/** GET /search. Every filter is optional; with no place the search covers all of NZ. */
export const searchQuerySchema = z.object({
  where: text(100).meta({
    description: 'Typed place, matched to our best place when there are no coordinates',
  }),
  placeId: text(200).meta({ description: 'A suggestion id from GET /places/suggest' }),
  lat: number(z.number().min(-48).max(-33)),
  lng: number(z.number().min(165).max(179.9)),
  airport: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .catch(undefined)
    .meta({ description: 'IATA code: also finds cars that deliver to that airport' }),
  radiusKm: number(z.number().positive()),
  start: text(40).meta({ description: 'Pick-up: "2026-10-12T10:00" in NZ time, or ISO 8601 with an offset' }),
  end: text(40).meta({ description: 'Return, in the same format' }),
  minDailyCents: number(z.number().int().min(0)),
  maxDailyCents: number(z.number().int().min(0)),
  types: list(BODY_TYPES),
  make: text(40),
  model: text(40),
  minYear: number(z.number().int().min(1900).max(2100)),
  maxYear: number(z.number().int().min(1900).max(2100)),
  transmission: z.enum(TRANSMISSIONS).optional().catch(undefined),
  minSeats: number(z.number().int().min(1).max(20)),
  fuel: list(FUEL_TYPES),
  electrified: flag.meta({ description: 'Hybrid, plug-in hybrid or electric' }),
  airportDelivery: flag,
  delivery: flag,
  instantBook: flag,
  minRating: number(z.number().min(1).max(5)).meta({
    description: 'Cars without reviews yet are left out when this is set',
  }),
  unlimitedKm: flag,
  petFriendly: flag,
  childSeat: flag,
  sort: z.enum(SORTS).default('recommended').catch('recommended'),
  page: z.coerce.number().int().min(1).max(500).default(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(24).catch(24),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const ratingSchema = z
  .object({ avg: z.number(), count: z.number().int() })
  .meta({ id: 'Rating', description: 'Average stars and how many reviews; count 0 shows as "New"' });

export const vehicleCardSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    title: z.string().meta({ description: 'e.g. "2022 Toyota RAV4"' }),
    make: z.string(),
    model: z.string(),
    year: z.number().int(),
    variant: z.string().optional(),
    photo: z.object({ url: z.string(), alt: z.string() }).nullable(),
    suburb: z.string().optional(),
    city: z.string().optional(),
    distanceKm: z.number().nullable().meta({ description: 'From the searched place; null without one' }),
    rating: ratingSchema,
    tripCount: z.number().int(),
    dailyCents: z.number().int(),
    estimate: z
      .object({
        days: z.number().int(),
        totalCents: z.number().int().meta({
          description:
            'Every mandatory charge for the dates (rental, service fee, mandatory protection, GST), plus airport delivery for an airport search',
        }),
        includesAirportDelivery: z.boolean(),
      })
      .nullable()
      .meta({ description: 'Only when the search has dates' }),
    instantBook: z.boolean(),
    delivery: z.boolean().meta({ description: 'Delivers to an address' }),
    airportDelivery: z.boolean(),
    bodyType: z.enum(BODY_TYPES),
    fuelType: z.enum(FUEL_TYPES),
    transmission: z.enum(TRANSMISSIONS),
    seats: z.number().int(),
    unlimitedKm: z.boolean(),
    petFriendly: z.boolean(),
    childSeat: z.boolean(),
    features: z.array(z.string()).meta({ description: 'Up to three key features' }),
  })
  .meta({ id: 'VehicleCard' });
export type VehicleCard = z.infer<typeof vehicleCardSchema>;

export const searchResponseSchema = z
  .object({
    results: z.array(vehicleCardSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
    place: z
      .object({
        label: z.string(),
        type: z.string(),
        lat: z.number(),
        lng: z.number(),
        airportCode: z.string().optional(),
      })
      .nullable()
      .meta({ description: 'The place searched; null for all of NZ' }),
    radiusKm: z.number(),
    dates: z.object({ start: z.iso.datetime(), end: z.iso.datetime(), days: z.number().int() }).nullable(),
    placeNotFound: z
      .boolean()
      .meta({ description: 'The typed place matched nothing, so the results cover all of NZ' }),
  })
  .meta({ id: 'SearchResults' });
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const makesResponseSchema = z
  .object({ makes: z.array(z.object({ make: z.string(), models: z.array(z.string()) })) })
  .meta({ id: 'VehicleMakes' });
