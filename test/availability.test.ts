import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db.js';
import { HttpError } from '../src/lib/http-error.js';
import { fromNzWallClock, parseNzDateTime, toNzLocalDateTime } from '../src/lib/nz-time.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import {
  addBlock,
  busyRanges,
  confirmTripDates,
  expandRecurringRules,
  findTripClash,
  rebuildRecurringBlocks,
  releaseTripDates,
  removeBlock,
  reserveTripDates,
} from '../src/modules/availability/availability.service.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createHost, createVehicle, nzDay } from './fixtures.js';

const HOUR_MS = 60 * 60 * 1000;
const at = (value: string) => parseNzDateTime(value)!;

async function reserve(vehicleId: mongoose.Types.ObjectId, start: string, end: string, holdUntil?: Date) {
  const bookingId = new mongoose.Types.ObjectId();
  await withTransaction((session) =>
    reserveTripDates(
      { vehicleId, bookingId, startAt: at(start), endAt: at(end), bufferHours: 2, holdUntil },
      session,
    ),
  );
  return bookingId;
}

describe('Availability service', () => {
  it('holds a trip with its preparation time, then books or releases it', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const holdUntil = new Date(Date.now() + 30 * 60_000);
    const bookingId = await reserve(vehicle._id, nzDay(5), nzDay(7), holdUntil);

    const blocks = await AvailabilityBlockModel.find({ bookingId }).sort({ startAt: 1 }).lean();
    expect(blocks.map((block) => [block.reason, block.expiresAt?.getTime()])).toEqual([
      ['HOLD', holdUntil.getTime()],
      ['BUFFER', holdUntil.getTime()],
    ]);
    expect(blocks[1]!.endAt.getTime() - blocks[1]!.startAt.getTime()).toBe(2 * HOUR_MS);
    expect((await VehicleModel.findById(vehicle._id))!.bookingSeq).toBe(1);

    await withTransaction((session) => confirmTripDates(bookingId, session));
    const confirmed = await AvailabilityBlockModel.find({ bookingId }).sort({ startAt: 1 }).lean();
    expect(confirmed.map((block) => [block.reason, block.expiresAt])).toEqual([
      ['BOOKED', undefined],
      ['BUFFER', undefined],
    ]);

    await withTransaction((session) => releaseTripDates(bookingId, session));
    expect(await AvailabilityBlockModel.countDocuments({ bookingId })).toBe(0);
  });

  it('refuses overlaps, including the preparation time either side', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    await reserve(vehicle._id, nzDay(5), nzDay(7));

    // Starting inside the first trip's preparation time.
    await expect(reserve(vehicle._id, nzDay(7, '11:00'), nzDay(9))).rejects.toMatchObject({
      status: 409,
      code: 'DATES_UNAVAILABLE',
    });
    // Ending less than 2 hours before the first trip starts.
    await expect(reserve(vehicle._id, nzDay(3), nzDay(5, '09:00'))).rejects.toBeInstanceOf(HttpError);
    // Right after the preparation time is fine.
    await expect(reserve(vehicle._id, nzDay(7, '12:00'), nzDay(9))).resolves.toBeDefined();
  });

  it('ignores holds whose time ran out', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    await reserve(vehicle._id, nzDay(5), nzDay(7), new Date(Date.now() - 1000));
    expect(
      await findTripClash({
        vehicleId: vehicle._id,
        startAt: at(nzDay(5)),
        endAt: at(nzDay(7)),
        bufferHours: 2,
      }),
    ).toBeNull();
    await expect(reserve(vehicle._id, nzDay(5), nzDay(7))).resolves.toBeDefined();
  });

  it('lets exactly one of 20 simultaneous bookings for the same car through', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(vehicle._id, nzDay(10), nzDay(12))),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(refused).toHaveLength(19);
    for (const { reason } of refused)
      expect(reason).toMatchObject({ status: 409, code: 'DATES_UNAVAILABLE' });
    expect(await AvailabilityBlockModel.countDocuments({ vehicleId: vehicle._id, reason: 'BOOKED' })).toBe(1);
  });

  it('lets Hosts and staff block dates, but never over a booking', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    await reserve(vehicle._id, nzDay(5), nzDay(7));

    await expect(
      addBlock({
        vehicleId: vehicle._id,
        startAt: at(nzDay(6)),
        endAt: at(nzDay(8)),
        reason: 'HOST_BLOCK',
        createdBy: host._id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'BOOKED_DATES' });

    const block = await addBlock({
      vehicleId: vehicle._id,
      startAt: at(nzDay(10)),
      endAt: at(nzDay(12)),
      reason: 'HOST_BLOCK',
      note: 'Servicing',
      createdBy: host._id,
    });
    expect(block).toMatchObject({ reason: 'HOST_BLOCK', note: 'Servicing' });

    // A trip can't be booked over it either.
    await expect(reserve(vehicle._id, nzDay(11), nzDay(13))).rejects.toMatchObject({ status: 409 });

    // A Host can only remove their own kind of block.
    const booked = await AvailabilityBlockModel.findOne({ reason: 'BOOKED' });
    expect(await removeBlock(vehicle._id, booked!.id)).toBe(false);
    expect(await removeBlock(vehicle._id, block.id)).toBe(true);
    expect(await removeBlock(vehicle._id, 'not-an-id')).toBe(false);
  });

  it('expands recurring rules in NZ time, including overnight ones', () => {
    const from = fromNzWallClock(2026, 10, 5); // a Monday
    const until = fromNzWallClock(2026, 10, 12);
    const weekdays = expandRecurringRules(
      [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00' }],
      from,
      until,
    );
    expect(weekdays.map((range) => toNzLocalDateTime(range.startAt))).toEqual([
      '2026-10-05T08:00',
      '2026-10-06T08:00',
      '2026-10-07T08:00',
      '2026-10-08T08:00',
      '2026-10-09T08:00',
    ]);
    expect(toNzLocalDateTime(weekdays[0]!.endAt)).toBe('2026-10-05T18:00');

    const sundays = expandRecurringRules(
      [{ daysOfWeek: [0], startTime: '00:00', endTime: '00:00' }],
      from,
      until,
    );
    expect(
      sundays.map((range) => [toNzLocalDateTime(range.startAt), toNzLocalDateTime(range.endAt)]),
    ).toEqual([['2026-10-11T00:00', '2026-10-12T00:00']]);
  });

  it('rebuilds recurring blocks for 12 months, skipping booked dates', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, {
      recurringRules: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '01:00', endTime: '05:00' }],
    });
    await reserve(vehicle._id, nzDay(3, '00:00'), nzDay(4, '12:00'));

    const result = await rebuildRecurringBlocks(vehicle._id);
    expect(result.blocks).toBeGreaterThan(350);
    expect(result.skipped.length).toBe(2);
    expect(await AvailabilityBlockModel.countDocuments({ vehicleId: vehicle._id, reason: 'RECURRING' })).toBe(
      result.blocks,
    );

    // Rebuilding again replaces rather than adds.
    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { recurringRules: [] } });
    expect(await rebuildRecurringBlocks(vehicle._id)).toEqual({ blocks: 0, skipped: [] });
    expect(await AvailabilityBlockModel.countDocuments({ vehicleId: vehicle._id, reason: 'RECURRING' })).toBe(
      0,
    );

    const busy = await busyRanges(vehicle._id, new Date(), new Date(Date.now() + 30 * 24 * HOUR_MS));
    expect(busy).toHaveLength(1);
  });
});
