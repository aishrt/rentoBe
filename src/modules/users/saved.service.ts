import mongoose from 'mongoose';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { nzTripDays, parseNzDateTime } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import { unavailableVehicleIds } from '../availability/availability.service.js';
import { hostGstStatus, toVehicleCard, type SearchDates } from '../search/search.service.js';
import { VehicleModel, type Vehicle } from '../vehicles/vehicle.model.js';
import type { LastSearchInput, SavedCar, SavedCarsResponse } from './saved.schemas.js';
import { UserModel, type LastSearch } from './user.model.js';

/*
 * Saved cars and the last search (plan §12.6, comparing cars): the heart on a car card, and the Saved
 * cars page, which prices each car for the dates the Guest last searched.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Cars saved with the heart, most recent first. */
export async function listFavourites(userId: string): Promise<string[]> {
  const user = await UserModel.findById(userId).select('favouriteVehicleIds status').lean();
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  // Accounts written by an upsert (the demo seed) may not have the list yet.
  return [...(user.favouriteVehicleIds ?? [])].reverse().map((id) => id.toString());
}

export async function saveFavourite(userId: string, vehicleId: string): Promise<void> {
  if (
    !mongoose.isValidObjectId(vehicleId) ||
    !(await VehicleModel.exists({ _id: vehicleId, status: 'ACTIVE' }))
  ) {
    throw new HttpError(404, 'NOT_FOUND', "We couldn't find that car.");
  }
  await UserModel.updateOne(
    { _id: userId },
    { $addToSet: { favouriteVehicleIds: new mongoose.Types.ObjectId(vehicleId) } },
  );
}

export async function removeFavourite(userId: string, vehicleId: string): Promise<void> {
  if (!mongoose.isValidObjectId(vehicleId)) return;
  await UserModel.updateOne(
    { _id: userId },
    { $pull: { favouriteVehicleIds: new mongoose.Types.ObjectId(vehicleId) } },
  );
}

/** Remembers a signed-in Guest's last search, for the estimated totals in Saved cars (plan §9, Days 7–9). */
export async function saveLastSearch(userId: string, input: LastSearchInput): Promise<void> {
  const startAt = input.start ? parseNzDateTime(input.start) : null;
  const endAt = input.end ? parseNzDateTime(input.end) : null;
  const dates = startAt && endAt && endAt > startAt ? { startAt, endAt } : {};
  await UserModel.updateOne(
    { _id: userId },
    {
      $set: {
        lastSearch: {
          ...(input.place && { place: input.place }),
          ...(input.lat !== undefined && input.lng !== undefined && { lat: input.lat, lng: input.lng }),
          ...dates,
        },
      },
    },
  );
}

/** The last search's dates while they're still ahead and within the longest trip allowed. */
function lastSearchDates(
  search: LastSearch | undefined,
  settings: PlatformSettings,
  now: Date,
): SearchDates | null {
  if (!search?.startAt || !search.endAt) return null;
  if (search.startAt <= now || search.endAt <= search.startAt) return null;
  const days = nzTripDays(search.startAt, search.endAt);
  if (days > settings.search.maxTripDays) return null;
  return { startAt: search.startAt, endAt: search.endAt, days };
}

type SavedVehicle = Vehicle & { _id: mongoose.Types.ObjectId };

/** Whether a live car can take the trip: its documents last, and the trip fits its rules (plan §3). */
function fitsTrip(vehicle: SavedVehicle, dates: SearchDates, settings: PlatformSettings, now: Date) {
  const inspection = vehicle.cofExpiry ?? vehicle.wofExpiry;
  if (!vehicle.regoExpiry || vehicle.regoExpiry < dates.endAt || !inspection || inspection < dates.endAt) {
    return false;
  }
  const { minDays, maxDays, minNoticeHours } = vehicle.rules;
  if (dates.days < minDays || dates.days > Math.min(maxDays, settings.search.maxTripDays)) return false;
  return dates.startAt.getTime() >= now.getTime() + minNoticeHours * HOUR_MS;
}

/**
 * GET /me/saved-cars: the Saved cars page (spec §8). Each car shows its estimated total for the last
 * searched dates when it can be booked for them, so the shortlist can be compared (spec §28).
 */
export async function listSavedCars(userId: string, now = new Date()): Promise<SavedCarsResponse> {
  const user = await UserModel.findById(userId).select('favouriteVehicleIds lastSearch status').lean();
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  const ids = [...(user.favouriteVehicleIds ?? [])].reverse();
  const settings = await getPlatformSettings();
  const dates = lastSearchDates(user.lastSearch, settings, now);

  const vehicles =
    ids.length > 0
      ? await VehicleModel.find({ _id: mongoose.trusted({ $in: ids }) }).lean<SavedVehicle[]>()
      : [];
  const gst = await hostGstStatus(vehicles.map((vehicle) => vehicle.hostId));
  const taken = dates
    ? new Set((await unavailableVehicleIds(dates.startAt, dates.endAt, now)).map(String))
    : new Set<string>();
  const byId = new Map(vehicles.map((vehicle) => [vehicle._id.toString(), vehicle]));

  // A car its Host deleted drops out of the list.
  const cars = ids.flatMap((id): SavedCar[] => {
    const vehicle = byId.get(id.toString());
    if (!vehicle) return [];
    const listed = vehicle.status === 'ACTIVE';
    const available =
      dates && listed ? !taken.has(id.toString()) && fitsTrip(vehicle, dates, settings, now) : null;
    const card = toVehicleCard(vehicle, {
      dates: available ? dates : null,
      settings,
      hostGstRegistered: gst.get(vehicle.hostId.toString()) ?? false,
    });
    return [{ ...card, listed, availableForDates: dates ? Boolean(available) : null }];
  });

  return {
    cars,
    search: dates
      ? {
          ...(user.lastSearch?.place && { place: user.lastSearch.place }),
          start: dates.startAt.toISOString(),
          end: dates.endAt.toISOString(),
          days: dates.days,
        }
      : null,
  };
}
