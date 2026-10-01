import type { ClientSession, Types } from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import type { NzAddress } from '../../lib/model-fields.js';
import { point } from '../../lib/model-fields.js';
import { nzTripDays, parseNzDateTime } from '../../lib/nz-time.js';
import type {
  CancellationTier,
  PlatformSettings,
  ProtectionPlan,
} from '../admin/platform-settings.schemas.js';
import { findTripClash } from '../availability/availability.service.js';
import { calculatePrice, defaultProtectionPlan, type PriceQuote } from '../pricing/pricing.js';
import type { DeliveryOption, Vehicle } from '../vehicles/vehicle.model.js';
import type { QuoteRequest, TripProblem } from '../vehicles/vehicles.schemas.js';

/*
 * The rules a trip must meet (plan §3, Validation rules: booking), checked the same way for a quote
 * and for a booking: dates, notice, length, documents, delivery options and the protection plan.
 * A quote lists every problem; creating a booking refuses the first one.
 */

const HOUR_MS = 60 * 60 * 1000;
const PAST_GRACE_MS = 5 * 60 * 1000;

export type TripVehicle = Pick<
  Vehicle,
  | 'pricing'
  | 'rules'
  | 'deliveryOptions'
  | 'location'
  | 'suburb'
  | 'city'
  | 'regoExpiry'
  | 'wofExpiry'
  | 'cofExpiry'
> & { _id: Types.ObjectId };

export interface EvaluatedTrip {
  startAt: Date;
  endAt: Date;
  days: number;
  pickup: DeliveryOption;
  dropoff: DeliveryOption;
  /** The Guest's address, for a DELIVERY option. */
  pickupAddress?: NzAddress;
  returnAddress?: NzAddress;
  plan?: ProtectionPlan;
  tier: CancellationTier;
  quote: PriceQuote;
  problems: TripProblem[];
}

const invalid = (fields: Record<string, string>) =>
  new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', fields);

/** Parses and checks the trip's dates; bad dates are an error rather than a problem to show. */
export function parseTripDates(start: string, end: string, now = new Date()) {
  const startAt = parseNzDateTime(start);
  const endAt = parseNzDateTime(end);
  if (!startAt) throw invalid({ start: 'Choose a pick-up date and time' });
  if (!endAt) throw invalid({ end: 'Choose a return date and time' });
  if (startAt.getTime() < now.getTime() - PAST_GRACE_MS)
    throw invalid({ start: 'Pick-up needs to be in the future' });
  if (endAt <= startAt) throw invalid({ end: 'Return needs to be after pick-up' });
  return { startAt, endAt };
}

/** Distance in km between two [lng, lat] points (haversine). */
export function distanceKm([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLng = radians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** The listing's tier, or the default when it's missing or no longer one Hosts may choose (plan §3). */
export function listingTier(vehicle: Pick<Vehicle, 'rules'>, settings: PlatformSettings): CancellationTier {
  const { tiers, hostSelectableTiers, defaultTier } = settings.cancellation;
  const chosen = vehicle.rules.cancellationTier;
  const code = chosen && hostSelectableTiers.includes(chosen) ? chosen : defaultTier;
  return tiers.find((tier) => tier.code === code) ?? tiers[0]!;
}

/** The Host's own location, which every listing has (onboarding step 6). */
function hostLocation(vehicle: TripVehicle): DeliveryOption {
  return (
    vehicle.deliveryOptions.find((option) => option.type === 'PICKUP') ?? {
      type: 'PICKUP',
      label: [vehicle.suburb, vehicle.city].filter(Boolean).join(', ') || 'Host location',
      feeCents: 0,
    }
  );
}

export async function evaluateTrip(
  vehicle: TripVehicle,
  request: QuoteRequest,
  options: {
    settings: PlatformSettings;
    hostGstRegistered: boolean;
    now?: Date;
    session?: ClientSession;
    /** Checking a booking's own dates again: its blocks don't count. */
    ignoreBookingId?: Types.ObjectId | string;
  },
): Promise<EvaluatedTrip> {
  const { settings, now = new Date() } = options;
  const { startAt, endAt } = parseTripDates(request.start, request.end, now);
  const days = nzTripDays(startAt, endAt);
  const problems: TripProblem[] = [];
  const rules = vehicle.rules;

  if (startAt.getTime() < now.getTime() + rules.minNoticeHours * HOUR_MS) {
    problems.push({
      code: 'NOTICE_TOO_SHORT',
      field: 'start',
      message: `This host needs at least ${rules.minNoticeHours} hours' notice before pick-up.`,
    });
  }
  if (days < rules.minDays) {
    problems.push({
      code: 'TRIP_TOO_SHORT',
      field: 'end',
      message: `The minimum trip for this car is ${rules.minDays} ${rules.minDays === 1 ? 'day' : 'days'}.`,
    });
  }
  const maxDays = Math.min(rules.maxDays, settings.search.maxTripDays);
  if (days > maxDays) {
    problems.push({
      code: 'TRIP_TOO_LONG',
      field: 'end',
      message: `The longest trip for this car is ${maxDays} days.`,
    });
  }
  const inspectionExpiry = vehicle.cofExpiry ?? vehicle.wofExpiry;
  if (!vehicle.regoExpiry || vehicle.regoExpiry < endAt || !inspectionExpiry || inspectionExpiry < endAt) {
    problems.push({
      code: 'DOCUMENTS_EXPIRE',
      field: 'end',
      message: "This car's registration or WOF runs out before the trip ends. Try an earlier return date.",
    });
  }

  const findOption = (id: string | undefined, field: string): DeliveryOption => {
    if (!id) return hostLocation(vehicle);
    const option = vehicle.deliveryOptions.find((candidate) => candidate._id?.toString() === id);
    if (option) return option;
    problems.push({
      code: 'OPTION_NOT_FOUND',
      field,
      message: "That pick-up or return option isn't offered for this car.",
    });
    return hostLocation(vehicle);
  };
  const pickup = findOption(request.pickupOptionId, 'pickupOptionId');
  const dropoff = request.returnOptionId ? findOption(request.returnOptionId, 'returnOptionId') : pickup;

  let deliveryAddress: NzAddress | undefined;
  if (pickup.type === 'DELIVERY' || dropoff.type === 'DELIVERY') {
    const input = request.deliveryAddress;
    if (!input) {
      problems.push({
        code: 'ADDRESS_NEEDED',
        field: 'deliveryAddress',
        message: 'Enter the address to deliver the car to.',
      });
    } else {
      const { lat, lng, ...address } = input;
      deliveryAddress = { ...address, location: point(lng, lat) };
      const option = pickup.type === 'DELIVERY' ? pickup : dropoff;
      if (
        vehicle.location &&
        option.radiusKm !== undefined &&
        distanceKm(vehicle.location.coordinates, [lng, lat]) > option.radiusKm
      ) {
        problems.push({
          code: 'OUTSIDE_DELIVERY_AREA',
          field: 'deliveryAddress',
          message: `That address is outside this host's ${option.radiusKm} km delivery area.`,
        });
      }
    }
  }

  let plan = defaultProtectionPlan(settings.protectionPlans);
  if (request.protectionPlanCode) {
    const chosen = settings.protectionPlans.find(
      (candidate) => candidate.code === request.protectionPlanCode,
    );
    if (chosen) plan = chosen;
    else
      problems.push({
        code: 'PLAN_NOT_FOUND',
        field: 'protectionPlanCode',
        message: "That protection plan isn't available.",
      });
  }

  const clash = await findTripClash(
    { vehicleId: vehicle._id, startAt, endAt, bufferHours: rules.bufferHours },
    { session: options.session, now, ignoreBookingId: options.ignoreBookingId },
  );
  if (clash) {
    problems.push({
      code: 'DATES_UNAVAILABLE',
      field: 'start',
      message: 'The car is already booked for some of those times.',
    });
  }

  const quote = calculatePrice({
    startAt,
    endAt,
    pricing: vehicle.pricing!,
    pickup,
    dropoff,
    protectionPlan: plan,
    fees: settings.fees,
    hostGstRegistered: options.hostGstRegistered,
  });

  return {
    startAt,
    endAt,
    days,
    pickup,
    dropoff,
    ...(deliveryAddress && pickup.type === 'DELIVERY' && { pickupAddress: deliveryAddress }),
    ...(deliveryAddress && dropoff.type === 'DELIVERY' && { returnAddress: deliveryAddress }),
    plan,
    tier: listingTier(vehicle, settings),
    quote,
    problems,
  };
}

/** The first problem as an error, for creating a booking (409 for taken dates, 400 otherwise). */
export function tripProblemError(problem: TripProblem): HttpError {
  if (problem.code === 'DATES_UNAVAILABLE') {
    return new HttpError(409, problem.code, 'Those dates are no longer available. Please choose others.');
  }
  return new HttpError(
    400,
    problem.code,
    problem.message,
    problem.field ? { [problem.field]: problem.message } : undefined,
  );
}
