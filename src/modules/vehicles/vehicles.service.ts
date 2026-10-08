import mongoose, { type Types } from 'mongoose';
import { logger } from '../../integrations/logger.js';
import { areaMapLink, fetchAreaMap, type MapImage } from '../../integrations/maps/area-map.js';
import { HttpError } from '../../lib/http-error.js';
import { memo } from '../../lib/memo.js';
import { addNzDays, parseNzDateTime } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { busyRanges } from '../availability/availability.service.js';
import { evaluateTrip, listingTier } from '../bookings/trip.service.js';
import { CmsBlockModel } from '../cms/cms-block.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { toVehicleCard } from '../search/search.service.js';
import { UserModel, type User } from '../users/user.model.js';
import { approximateArea, complianceSummary, publicPhotos, vehicleTitle } from './vehicle-view.js';
import { VehicleModel, liveVehicleFilter, type DeliveryOption, type Vehicle } from './vehicle.model.js';
import type { Quote, QuoteRequest, VehicleDetail } from './vehicles.schemas.js';

const notFound = () =>
  new HttpError(404, 'NOT_FOUND', "We couldn't find that car. It may no longer be listed.");

/** A live car by id, or 404. */
export async function findLiveVehicle(id: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const vehicle = await VehicleModel.findOne({ _id: id, ...liveVehicleFilter() });
  if (!vehicle) throw notFound();
  return vehicle;
}

type HostFields = Pick<
  User,
  'firstName' | 'avatarUrl' | 'hostProfile' | 'identityVerification' | 'createdAt'
> & {
  _id: Types.ObjectId;
};

/** What a Guest may see of a Host (plan §6.2): first name, photo, rating, trips and response rate. */
export function publicHost(host: HostFields) {
  return {
    id: host._id.toString(),
    firstName: host.firstName,
    ...(host.avatarUrl && { avatarUrl: host.avatarUrl }),
    rating: host.hostProfile?.rating ?? { avg: 0, count: 0 },
    tripCount: host.hostProfile?.tripCount ?? 0,
    ...(host.hostProfile?.responseRate !== undefined && { responseRate: host.hostProfile.responseRate }),
    verified: host.identityVerification?.status === 'APPROVED',
    joinedYear: host.createdAt.getFullYear(),
    ...(host.hostProfile?.bio && { bio: host.hostProfile.bio }),
  };
}

const HOST_FIELDS = 'firstName avatarUrl hostProfile identityVerification createdAt';

/** A delivery option as the public sees it: the suburb for a pickup point, never the street. */
export function deliveryOptionSummary(option: DeliveryOption, vehicle: Pick<Vehicle, 'suburb' | 'city'>) {
  const area =
    option.type === 'PICKUP'
      ? [vehicle.suburb, vehicle.city].filter(Boolean).join(', ')
      : option.type === 'CUSTOM' && option.address
        ? [option.address.suburb, option.address.city].filter(Boolean).join(', ')
        : undefined;
  return {
    id: option._id?.toString() ?? option.type.toLowerCase(),
    type: option.type,
    label: option.label,
    feeCents: option.feeCents,
    ...(option.airportCode && { airportCode: option.airportCode }),
    ...(option.type === 'DELIVERY' && option.radiusKm !== undefined && { radiusKm: option.radiusKm }),
    ...(area && { area }),
  };
}

/** GET /vehicles/{slug}: the listing page (plan §9, Days 8–10). */
export async function getVehicleDetail(slug: string, now = new Date()): Promise<VehicleDetail> {
  const vehicle = await VehicleModel.findOne({ slug: slug.toLowerCase(), ...liveVehicleFilter() }).lean();
  if (!vehicle) throw notFound();
  const [host, settings] = await Promise.all([
    UserModel.findById(vehicle.hostId).select(HOST_FIELDS).lean<HostFields>(),
    getPlatformSettings(),
  ]);
  if (!host) throw notFound();
  const approx = vehicle.location
    ? approximateArea(vehicle._id.toString(), vehicle.location.coordinates)
    : null;

  return {
    id: vehicle._id.toString(),
    slug: vehicle.slug,
    title: vehicleTitle(vehicle),
    make: vehicle.make ?? '',
    model: vehicle.model ?? '',
    year: vehicle.year ?? 0,
    ...(vehicle.variant && { variant: vehicle.variant }),
    bodyType: vehicle.bodyType!,
    fuelType: vehicle.fuelType!,
    transmission: vehicle.transmission!,
    seats: vehicle.seats ?? 0,
    doors: vehicle.doors ?? 0,
    features: vehicle.features,
    powertrain: vehicle.powertrain ?? null,
    fuelPolicy: vehicle.fuelPolicy,
    kmAllowancePerDay: vehicle.unlimitedKm ? null : (vehicle.kmAllowancePerDay ?? null),
    unlimitedKm: vehicle.unlimitedKm,
    extraKmCents: vehicle.pricing?.extraKmCents ?? 0,
    petFriendly: vehicle.petFriendly,
    childSeat: vehicle.childSeat,
    pricing: {
      dailyCents: vehicle.pricing?.dailyCents ?? 0,
      weeklyDiscountPct: vehicle.pricing?.weeklyDiscountPct ?? 0,
      monthlyDiscountPct: vehicle.pricing?.monthlyDiscountPct ?? 0,
    },
    rules: {
      minDays: vehicle.rules.minDays,
      maxDays: Math.min(vehicle.rules.maxDays, settings.search.maxTripDays),
      minNoticeHours: vehicle.rules.minNoticeHours,
      bufferHours: vehicle.rules.bufferHours,
      instantBook: vehicle.rules.instantBook,
    },
    cancellationTier: listingTier(vehicle, settings),
    photos: publicPhotos(vehicle),
    compliance: complianceSummary(vehicle, now),
    location: {
      ...(vehicle.suburb && { suburb: vehicle.suburb }),
      ...(vehicle.city && { city: vehicle.city }),
      ...(vehicle.region && { region: vehicle.region }),
      approx,
      mapUrl: approx ? areaMapLink(vehicle._id.toString(), approx) : null,
    },
    deliveryOptions: vehicle.deliveryOptions.map((option) => deliveryOptionSummary(option, vehicle)),
    protectionPlans: settings.protectionPlans,
    rating: { avg: Math.round(vehicle.rating.avg * 100) / 100, count: vehicle.rating.count },
    tripCount: vehicle.tripCount,
    host: publicHost(host),
  };
}

/**
 * GET /vehicles/{id}/area-map: the listing's map image, fetched from Google with the server's key
 * (plan §1.2). 503 when Google isn't set up or refuses it, and the website shows its sketch instead.
 */
export async function vehicleAreaMap(id: string): Promise<MapImage> {
  const vehicle = await findLiveVehicle(id);
  if (!vehicle.location) throw notFound();
  const area = approximateArea(vehicle._id.toString(), vehicle.location.coordinates);
  const image = await fetchAreaMap(area).catch((error: unknown) => {
    logger.warn({ err: error }, 'Google Maps Static API failed; the listing shows its sketch');
    return null;
  });
  if (!image) throw new HttpError(503, 'MAP_UNAVAILABLE', "The map isn't available right now.");
  return image;
}

/** The homepage's featured cars block (plan §12.6): admins pick them in `home.featured-vehicles`. */
export const FEATURED_BLOCK_KEY = 'home.featured-vehicles';
const FEATURED_COUNT = 8;

/** Live cars whose rego and WOF (or CoF) are still current: search leaves the others out, so must this. */
function bookableToday() {
  const now = new Date();
  return {
    ...liveVehicleFilter(),
    regoExpiry: mongoose.trusted({ $gte: now }),
    $or: [{ wofExpiry: mongoose.trusted({ $gte: now }) }, { cofExpiry: mongoose.trusted({ $gte: now }) }],
  };
}

/**
 * GET /vehicles/featured: the cars admins picked, or else the best-rated live cars, newest first
 * among equals. Cached for 60 s (plan §4.1).
 */
export function featuredVehicles() {
  return memo('vehicles:featured', 60_000, async () => {
    const settings = await getPlatformSettings();
    const block = await CmsBlockModel.findOne({ key: FEATURED_BLOCK_KEY }).lean();
    const picked = ((block?.content as { vehicleIds?: string[] } | undefined)?.vehicleIds ?? []).filter(
      (id) => mongoose.isValidObjectId(id),
    );

    let vehicles = picked.length
      ? await VehicleModel.find({ _id: mongoose.trusted({ $in: picked }), ...bookableToday() }).lean()
      : [];
    vehicles.sort((a, b) => picked.indexOf(a._id.toString()) - picked.indexOf(b._id.toString()));
    if (vehicles.length === 0) {
      vehicles = await VehicleModel.find(bookableToday())
        .sort({ 'rating.avg': -1, tripCount: -1, createdAt: -1 })
        .limit(FEATURED_COUNT)
        .lean();
    }
    return {
      vehicles: vehicles
        .slice(0, FEATURED_COUNT)
        .map((vehicle) => toVehicleCard(vehicle, { dates: null, settings })),
    };
  });
}

const MAX_RANGE_DAYS = 400;

/** GET /vehicles/{id}/availability: when the car is taken, for the listing's date picker. */
export async function vehicleAvailability(id: string, from?: string, to?: string, now = new Date()) {
  const vehicle = await findLiveVehicle(id);
  const fromAt = (from && parseNzDateTime(from.length === 10 ? `${from}T00:00` : from)) || now;
  const requestedTo = to && parseNzDateTime(to.length === 10 ? `${to}T00:00` : to);
  const toAt =
    requestedTo && requestedTo > fromAt && requestedTo <= addNzDays(fromAt, MAX_RANGE_DAYS)
      ? requestedTo
      : addNzDays(fromAt, 180);
  const busy = await busyRanges(vehicle._id, fromAt, toAt, now);
  return {
    from: fromAt.toISOString(),
    to: toAt.toISOString(),
    busy: busy.map((range) => ({ start: range.startAt.toISOString(), end: range.endAt.toISOString() })),
    minNoticeHours: vehicle.rules.minNoticeHours,
    bufferHours: vehicle.rules.bufferHours,
    minDays: vehicle.rules.minDays,
    maxDays: vehicle.rules.maxDays,
  };
}

const REVIEWS_PAGE_SIZE = 10;

/** GET /vehicles/{id}/reviews: published Guest reviews of the car, newest first. */
export async function vehicleReviews(id: string, page = 1) {
  const vehicle = await findLiveVehicle(id);
  const filter = {
    vehicleId: vehicle._id,
    direction: 'GUEST_TO_HOST',
    status: 'PUBLISHED',
    'moderation.state': 'CLEAR',
  };
  const [reviews, total, categories] = await Promise.all([
    ReviewModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * REVIEWS_PAGE_SIZE)
      .limit(REVIEWS_PAGE_SIZE)
      .lean(),
    ReviewModel.countDocuments(filter),
    ReviewModel.aggregate<{
      cleanliness: number | null;
      communication: number | null;
      pickupReturn: number | null;
    }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          cleanliness: { $avg: '$cleanliness' },
          communication: { $avg: '$communication' },
          pickupReturn: { $avg: '$pickupReturn' },
        },
      },
    ]),
  ]);
  const authors = await UserModel.find({
    _id: mongoose.trusted({ $in: reviews.map((review) => review.authorId) }),
  })
    .select('firstName avatarUrl')
    .lean();
  const round = (value: number | null | undefined) => (value == null ? null : Math.round(value * 10) / 10);

  return {
    reviews: reviews.map((review) => {
      const author = authors.find((candidate) => candidate._id.equals(review.authorId));
      return {
        id: review._id.toString(),
        author: {
          firstName: author?.firstName ?? 'A guest',
          ...(author?.avatarUrl && { avatarUrl: author.avatarUrl }),
        },
        overall: review.overall,
        ...(review.body && { body: review.body }),
        createdAt: review.createdAt.toISOString(),
      };
    }),
    total,
    page,
    pageSize: REVIEWS_PAGE_SIZE,
    rating: { avg: Math.round(vehicle.rating.avg * 100) / 100, count: vehicle.rating.count },
    categories: {
      cleanliness: round(categories[0]?.cleanliness),
      communication: round(categories[0]?.communication),
      pickupReturn: round(categories[0]?.pickupReturn),
    },
  };
}

/** POST /vehicles/{id}/quote: the price for chosen dates and options, and anything in the way. */
export async function quoteVehicle(id: string, request: QuoteRequest, now = new Date()): Promise<Quote> {
  const vehicle = await findLiveVehicle(id);
  const [settings, host] = await Promise.all([
    getPlatformSettings(),
    UserModel.findById(vehicle.hostId).select('hostProfile.gstRegistered').lean(),
  ]);
  const trip = await evaluateTrip(vehicle, request, {
    settings,
    hostGstRegistered: host?.hostProfile?.gstRegistered ?? false,
    now,
  });
  return toQuote(trip, vehicle, vehicle.rules.instantBook);
}

export function toQuote(
  trip: Awaited<ReturnType<typeof evaluateTrip>>,
  vehicle: Pick<Vehicle, 'suburb' | 'city'>,
  instantBook: boolean,
): Quote {
  const { lineItems, price } = trip.quote;
  const mandatoryCents = lineItems
    .filter((item) => item.mandatory)
    .reduce((sum, item) => sum + item.amountCents, 0);
  return {
    available: trip.problems.length === 0,
    problems: trip.problems,
    start: trip.startAt.toISOString(),
    end: trip.endAt.toISOString(),
    days: trip.days,
    lineItems,
    price: {
      subtotalCents: price.subtotalCents,
      deliveryCents: price.deliveryCents,
      serviceFeeCents: price.serviceFeeCents,
      protectionCents: price.protectionCents,
      gstCents: price.gstCents,
      totalCents: price.totalCents,
      mandatoryCents,
      optionalCents: price.totalCents - mandatoryCents,
    },
    protectionPlan: trip.plan ?? null,
    pickup: deliveryOptionSummary(trip.pickup, vehicle),
    dropoff: deliveryOptionSummary(trip.dropoff, vehicle),
    instantBook,
    cancellationTier: trip.tier,
  };
}
