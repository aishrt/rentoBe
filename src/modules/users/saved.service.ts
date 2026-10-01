import mongoose from 'mongoose';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { parseNzDateTime } from '../../lib/nz-time.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import type { LastSearchInput } from './saved.schemas.js';
import { UserModel } from './user.model.js';

/*
 * Saved cars and the last search (plan §12.6, comparing cars): the heart on a car card, and the dates
 * Saved cars prices each car for. The Saved cars page itself arrives with the Guest dashboard.
 */

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
