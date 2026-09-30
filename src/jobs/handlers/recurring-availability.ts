import mongoose from 'mongoose';
import { enqueue } from '../queue.js';
import { fromNzWallClock, toNzWallClock } from '../../lib/nz-time.js';
import { rebuildRecurringBlocks } from '../../modules/availability/availability.service.js';
import { VehicleModel } from '../../modules/vehicles/vehicle.model.js';
import type { JobContext } from './index.js';

/** 3 am on the 1st of next month in NZ, when the monthly top-up runs. */
export function nextMonthlyRun(now: Date): Date {
  const { year, month } = toNzWallClock(now);
  return month === 12 ? fromNzWallClock(year + 1, 1, 1, 3) : fromNzWallClock(year, month + 1, 1, 3);
}

/** Queues the next monthly top-up. The dated key means every instance queues it only once. */
export async function scheduleRecurringAvailability(now = new Date()) {
  const runAt = nextMonthlyRun(now);
  const { year, month } = toNzWallClock(runAt);
  await enqueue(
    'availability.expandRecurring',
    {},
    { runAt, uniqueKey: `monthly.recurringAvailability:${year}-${month}` },
  );
}

/**
 * `availability.expandRecurring` (plan §4.3): recurring rules are expanded 12 months ahead, so each
 * month the blocks are topped up for every car with rules. With a vehicleId, just that car.
 */
export async function expandRecurringJob({ vehicleId }: { vehicleId?: string }, { log }: JobContext) {
  if (!vehicleId) await scheduleRecurringAvailability();
  const vehicles = await VehicleModel.find({
    ...(vehicleId ? { _id: vehicleId } : {}),
    'recurringRules.0': mongoose.trusted({ $exists: true }),
    status: mongoose.trusted({ $nin: ['REJECTED'] }),
  })
    .select('_id')
    .lean();
  let blocks = 0;
  for (const vehicle of vehicles) {
    blocks += (await rebuildRecurringBlocks(vehicle._id)).blocks;
  }
  log.info({ vehicles: vehicles.length, blocks }, 'Recurring availability topped up');
}
