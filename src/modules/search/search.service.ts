import mongoose, { type PipelineStage, type Types } from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { memo } from '../../lib/memo.js';
import { nzTripDays, parseNzDateTime } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import { unavailableVehicleIds } from '../availability/availability.service.js';
import { calculatePrice, defaultProtectionPlan } from '../pricing/pricing.js';
import { UserModel } from '../users/user.model.js';
import { coverPhoto, keyFeatures, vehicleTitle } from '../vehicles/vehicle-view.js';
import { VehicleModel, type Vehicle } from '../vehicles/vehicle.model.js';
import { resolveSearchPlace, type ResolvedPlace } from './places.service.js';
import type { SearchQuery, SearchResponse, VehicleCard } from './search.schemas.js';

/*
 * Search and Browse Cars (plan §3, Key rules: location search): the cars with a block in the
 * requested dates are found first, then one $geoNear aggregation applies the radius and every filter
 * in spec §5, sorts and paginates, and returns each car's distance from the searched place.
 */

const HOUR_MS = 60 * 60 * 1000;
const KM = 1000;
/** An airport search also finds cars this far away that deliver to the airport (plan §3). */
const AIRPORT_REACH_KM = 250;
/** A pick-up a few minutes in the past (a slow form) is still accepted. */
const PAST_GRACE_MS = 15 * 60 * 1000;
const ELECTRIFIED = ['HYBRID', 'PHEV', 'EV'] as const;

type CardVehicle = Pick<
  Vehicle,
  | 'slug'
  | 'make'
  | 'model'
  | 'year'
  | 'variant'
  | 'photos'
  | 'suburb'
  | 'city'
  | 'rating'
  | 'tripCount'
  | 'pricing'
  | 'rules'
  | 'deliveryOptions'
  | 'bodyType'
  | 'fuelType'
  | 'transmission'
  | 'seats'
  | 'unlimitedKm'
  | 'petFriendly'
  | 'childSeat'
  | 'features'
  | 'hostId'
> & { _id: Types.ObjectId; distanceMeters?: number };

const CARD_FIELDS = {
  slug: 1,
  make: 1,
  model: 1,
  year: 1,
  variant: 1,
  photos: 1,
  suburb: 1,
  city: 1,
  rating: 1,
  tripCount: 1,
  pricing: 1,
  rules: 1,
  deliveryOptions: 1,
  bodyType: 1,
  fuelType: 1,
  transmission: 1,
  seats: 1,
  unlimitedKm: 1,
  petFriendly: 1,
  childSeat: 1,
  features: 1,
  hostId: 1,
  distanceMeters: 1,
} as const;

const invalid = (fields: Record<string, string>) =>
  new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', fields);

export interface SearchDates {
  startAt: Date;
  endAt: Date;
  days: number;
}

/** The search's dates, checked against the rules in plan §3 (Validation rules: search). */
export function parseSearchDates(
  start: string | undefined,
  end: string | undefined,
  settings: PlatformSettings,
  now = new Date(),
): SearchDates | null {
  if (!start && !end) return null;
  const startAt = start ? parseNzDateTime(start) : null;
  const endAt = end ? parseNzDateTime(end) : null;
  if (!startAt) throw invalid({ start: 'Choose a pick-up date and time' });
  if (!endAt) throw invalid({ end: 'Choose a return date and time' });
  if (startAt.getTime() < now.getTime() - PAST_GRACE_MS)
    throw invalid({ start: 'Pick-up needs to be in the future' });
  if (endAt <= startAt) throw invalid({ end: 'Return needs to be after pick-up' });
  const days = nzTripDays(startAt, endAt);
  if (days > settings.search.maxTripDays) {
    throw invalid({ end: `Trips can be up to ${settings.search.maxTripDays} days long` });
  }
  return { startAt, endAt, days };
}

const exactText = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/** The filters of spec §5 as a MongoDB match (plan §9, Days 6–8). */
function filterMatch(query: SearchQuery, validUntil: Date, excludeIds: Types.ObjectId[]) {
  const and: Record<string, unknown>[] = [
    { status: 'ACTIVE' },
    // Rego and WOF (or CoF) must stay valid until the trip ends (plan §3, expired documents).
    { regoExpiry: { $gte: validUntil } },
    { $or: [{ wofExpiry: { $gte: validUntil } }, { cofExpiry: { $gte: validUntil } }] },
  ];
  if (excludeIds.length > 0) and.push({ _id: { $nin: excludeIds } });
  if (query.minDailyCents !== undefined) and.push({ 'pricing.dailyCents': { $gte: query.minDailyCents } });
  if (query.maxDailyCents !== undefined) and.push({ 'pricing.dailyCents': { $lte: query.maxDailyCents } });
  if (query.types?.length) and.push({ bodyType: { $in: query.types } });
  if (query.make) and.push({ make: exactText(query.make) });
  if (query.model) and.push({ model: exactText(query.model) });
  if (query.minYear !== undefined) and.push({ year: { $gte: query.minYear } });
  if (query.maxYear !== undefined) and.push({ year: { $lte: query.maxYear } });
  if (query.transmission) and.push({ transmission: query.transmission });
  if (query.minSeats !== undefined) and.push({ seats: { $gte: query.minSeats } });
  if (query.fuel?.length) and.push({ fuelType: { $in: query.fuel } });
  if (query.electrified) and.push({ fuelType: { $in: ELECTRIFIED } });
  if (query.airportDelivery) and.push({ 'deliveryOptions.type': 'AIRPORT' });
  if (query.delivery) and.push({ 'deliveryOptions.type': { $in: ['DELIVERY', 'CUSTOM'] } });
  if (query.instantBook) and.push({ 'rules.instantBook': true });
  if (query.minRating !== undefined) {
    // Cars without reviews show "New", and a minimum rating leaves them out (plan §9, Days 7–9).
    and.push({ 'rating.avg': { $gte: query.minRating } }, { 'rating.count': { $gte: 1 } });
  }
  if (query.unlimitedKm) and.push({ unlimitedKm: true });
  if (query.petFriendly) and.push({ petFriendly: true });
  if (query.childSeat) and.push({ childSeat: true });
  return { $and: and };
}

/** The listing's own trip rules for the dates: minimum notice and trip length (plan §3, booking). */
function tripRulesMatch(dates: SearchDates, now: Date): PipelineStage.Match {
  return {
    $match: {
      $expr: {
        $and: [
          { $lte: [{ $ifNull: ['$rules.minDays', 1] }, dates.days] },
          { $gte: [{ $ifNull: ['$rules.maxDays', 365] }, dates.days] },
          {
            $lte: [
              { $add: [now, { $multiply: [{ $ifNull: ['$rules.minNoticeHours', 0] }, HOUR_MS] }] },
              dates.startAt,
            ],
          },
        ],
      },
    },
  };
}

function sortStages(sort: SearchQuery['sort'], hasPlace: boolean): PipelineStage.FacetPipelineStage[] {
  switch (sort) {
    case 'price_asc':
      return [{ $sort: { 'pricing.dailyCents': 1, _id: 1 } }];
    case 'price_desc':
      return [{ $sort: { 'pricing.dailyCents': -1, _id: 1 } }];
    case 'rating':
      return [
        { $addFields: { ratingSort: { $cond: [{ $gt: ['$rating.count', 0] }, '$rating.avg', -1] } } },
        { $sort: { ratingSort: -1, 'rating.count': -1, _id: 1 } },
      ];
    case 'newest':
      return [{ $sort: { createdAt: -1, _id: 1 } }];
    case 'distance':
      if (hasPlace) return [{ $sort: { distanceMeters: 1, _id: 1 } }];
      break;
    case 'recommended':
      break;
  }
  // Recommended: well-reviewed, well-travelled and Instant Book cars first, closer ones before farther.
  return [
    {
      $addFields: {
        score: {
          $add: [
            { $multiply: [{ $cond: [{ $gt: ['$rating.count', 0] }, '$rating.avg', 4.2] }, 2] },
            { $divide: [{ $min: ['$tripCount', 30] }, 10] },
            { $cond: ['$rules.instantBook', 1, 0] },
            { $multiply: [-1, { $min: [{ $divide: [{ $ifNull: ['$distanceMeters', 0] }, 25 * KM] }, 4] }] },
          ],
        },
      },
    },
    { $sort: { score: -1, _id: 1 } },
  ];
}

/** Turns a car into its search card, with an estimated total when there are dates (plan §5). */
export function toVehicleCard(
  vehicle: CardVehicle,
  context: {
    dates: SearchDates | null;
    settings: PlatformSettings;
    airportCode?: string;
    hostGstRegistered?: boolean;
  },
): VehicleCard {
  const airportOption = context.airportCode
    ? vehicle.deliveryOptions.find(
        (option) => option.type === 'AIRPORT' && option.airportCode === context.airportCode,
      )
    : undefined;
  let estimate: VehicleCard['estimate'] = null;
  if (context.dates && vehicle.pricing) {
    const quote = calculatePrice({
      startAt: context.dates.startAt,
      endAt: context.dates.endAt,
      pricing: vehicle.pricing,
      pickup: airportOption,
      dropoff: airportOption,
      protectionPlan: defaultProtectionPlan(context.settings.protectionPlans),
      fees: context.settings.fees,
      hostGstRegistered: context.hostGstRegistered ?? false,
    });
    estimate = {
      days: quote.days,
      totalCents: quote.price.totalCents,
      includesAirportDelivery: Boolean(airportOption),
    };
  }

  return {
    id: vehicle._id.toString(),
    slug: vehicle.slug,
    title: vehicleTitle(vehicle),
    make: vehicle.make ?? '',
    model: vehicle.model ?? '',
    year: vehicle.year ?? 0,
    ...(vehicle.variant && { variant: vehicle.variant }),
    photo: coverPhoto(vehicle),
    ...(vehicle.suburb && { suburb: vehicle.suburb }),
    ...(vehicle.city && { city: vehicle.city }),
    distanceKm:
      vehicle.distanceMeters === undefined ? null : Math.round((vehicle.distanceMeters / KM) * 10) / 10,
    rating: { avg: Math.round(vehicle.rating.avg * 100) / 100, count: vehicle.rating.count },
    tripCount: vehicle.tripCount,
    dailyCents: vehicle.pricing?.dailyCents ?? 0,
    estimate,
    instantBook: vehicle.rules.instantBook,
    delivery: vehicle.deliveryOptions.some(
      (option) => option.type === 'DELIVERY' || option.type === 'CUSTOM',
    ),
    airportDelivery: vehicle.deliveryOptions.some((option) => option.type === 'AIRPORT'),
    bodyType: vehicle.bodyType!,
    fuelType: vehicle.fuelType!,
    transmission: vehicle.transmission!,
    seats: vehicle.seats ?? 0,
    unlimitedKm: vehicle.unlimitedKm,
    petFriendly: vehicle.petFriendly,
    childSeat: vehicle.childSeat,
    features: keyFeatures(vehicle),
  };
}

async function hostGstStatus(hostIds: Types.ObjectId[]): Promise<Map<string, boolean>> {
  if (hostIds.length === 0) return new Map();
  const hosts = await UserModel.find({ _id: mongoose.trusted({ $in: hostIds }) })
    .select('hostProfile.gstRegistered')
    .lean();
  return new Map(hosts.map((host) => [host._id.toString(), host.hostProfile?.gstRegistered ?? false]));
}

/** GET /search (plan §11). */
export async function searchVehicles(query: SearchQuery, now = new Date()): Promise<SearchResponse> {
  const settings = await getPlatformSettings();
  if (
    query.minDailyCents !== undefined &&
    query.maxDailyCents !== undefined &&
    query.minDailyCents > query.maxDailyCents
  ) {
    throw invalid({ minDailyCents: 'The minimum price is higher than the maximum' });
  }
  if (query.minYear !== undefined && query.maxYear !== undefined && query.minYear > query.maxYear) {
    throw invalid({ minYear: 'The earliest year is after the latest' });
  }

  const dates = parseSearchDates(query.start, query.end, settings, now);
  const { min, max } = settings.search.radiusKm;
  const radiusKm = Math.min(Math.max(query.radiusKm ?? settings.search.radiusKm.default, min), max);
  const place = await resolveSearchPlace(query);
  const placeNotFound = !place && Boolean(query.where || query.placeId);

  const blocked = dates ? await unavailableVehicleIds(dates.startAt, dates.endAt, now) : [];
  const match = filterMatch(query, dates?.endAt ?? now, blocked);
  const pipeline: PipelineStage[] = [];

  if (place) {
    const reachKm = place.airportCode ? Math.max(radiusKm, AIRPORT_REACH_KM) : radiusKm;
    pipeline.push({
      $geoNear: {
        near: { type: 'Point', coordinates: [place.lng, place.lat] },
        distanceField: 'distanceMeters',
        maxDistance: reachKm * KM,
        spherical: true,
        key: 'location',
        query: match,
      },
    });
    if (place.airportCode) {
      // Nearby cars, and cars farther out that deliver to this airport (plan §3, airport search).
      pipeline.push({
        $match: {
          $or: [
            { distanceMeters: { $lte: radiusKm * KM } },
            { deliveryOptions: { $elemMatch: { type: 'AIRPORT', airportCode: place.airportCode } } },
          ],
        },
      });
    }
  } else {
    pipeline.push({ $match: match });
  }
  if (dates) pipeline.push(tripRulesMatch(dates, now));

  pipeline.push({
    $facet: {
      total: [{ $count: 'count' }],
      results: [
        ...sortStages(query.sort, Boolean(place)),
        { $skip: (query.page - 1) * query.pageSize },
        { $limit: query.pageSize },
        { $project: CARD_FIELDS },
      ],
    },
  });

  const [facets] = await VehicleModel.aggregate<{ total: { count: number }[]; results: CardVehicle[] }>(
    pipeline,
  );
  const rows = facets?.results ?? [];
  const gst = await hostGstStatus(rows.map((row) => row.hostId));

  return {
    results: rows.map((row) =>
      toVehicleCard(row, {
        dates,
        settings,
        airportCode: place?.airportCode,
        hostGstRegistered: gst.get(row.hostId.toString()),
      }),
    ),
    total: facets?.total[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    place: place ? placeSummary(place) : null,
    radiusKm,
    dates: dates
      ? { start: dates.startAt.toISOString(), end: dates.endAt.toISOString(), days: dates.days }
      : null,
    placeNotFound,
  };
}

const placeSummary = (place: ResolvedPlace) => ({
  label: place.label,
  type: place.type,
  lat: place.lat,
  lng: place.lng,
  ...(place.airportCode && { airportCode: place.airportCode }),
});

/** Makes and models of live cars, for the make and model filter. Cached for 5 minutes. */
export function listMakes() {
  return memo('vehicles:makes', 5 * 60_000, async () => {
    const rows = await VehicleModel.aggregate<{ _id: string; models: string[] }>([
      { $match: { status: 'ACTIVE', make: { $type: 'string' } } },
      { $group: { _id: '$make', models: { $addToSet: '$model' } } },
      { $sort: { _id: 1 } },
    ]);
    return {
      makes: rows.map((row) => ({
        make: row._id,
        models: row.models.filter(Boolean).sort((a, b) => a.localeCompare(b)),
      })),
    };
  });
}
