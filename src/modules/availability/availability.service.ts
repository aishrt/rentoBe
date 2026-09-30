import mongoose, { type ClientSession, type Types } from 'mongoose';
import { withTransaction } from '../../db.js';
import { HttpError } from '../../lib/http-error.js';
import { addNzDays, fromNzWallClock, startOfNzDay, toNzWallClock } from '../../lib/nz-time.js';
import { VehicleModel, type RecurringRule } from '../vehicles/vehicle.model.js';
import {
  AvailabilityBlockModel,
  type AvailabilityBlock,
  type AvailabilityBlockDocument,
  type BlockReason,
} from './availability-block.model.js';

/*
 * The only code that writes availabilityBlocks (plan §3, double-booking prevention). Every write
 * first bumps the car's bookingSeq inside a transaction, so two writes for the same car can't both
 * pass the overlap check: MongoDB aborts one, retries it, and the retry sees the other's blocks.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Recurring rules are expanded this far ahead, and topped up monthly (plan §3). */
const RECURRING_MONTHS = 12;

type Id = Types.ObjectId | string;

export const datesUnavailable = (message = 'Those dates are no longer available. Please choose others.') =>
  new HttpError(409, 'DATES_UNAVAILABLE', message);

/** Blocks that still count: everything except a HOLD (or its buffer) whose time ran out. */
export const activeBlock = (now = new Date()) => ({
  $or: [{ expiresAt: mongoose.trusted({ $exists: false }) }, { expiresAt: mongoose.trusted({ $gt: now }) }],
});

const overlapping = (startAt: Date, endAt: Date) => ({
  startAt: mongoose.trusted({ $lt: endAt }),
  endAt: mongoose.trusted({ $gt: startAt }),
});

/** The trip's own blocks (the dates, and the Host's preparation time after them). */
const TRIP_REASONS: BlockReason[] = ['BOOKED', 'HOLD'];

async function bumpBookingSeq(vehicleId: Id, session: ClientSession) {
  const result = await VehicleModel.updateOne({ _id: vehicleId }, { $inc: { bookingSeq: 1 } }, { session });
  if (result.matchedCount === 0) throw new HttpError(404, 'NOT_FOUND', 'No car with that id.');
}

/**
 * Whether a trip fits: the dates can't overlap any block, and the preparation time after it can't
 * run into another trip. Checked again inside the booking transaction.
 */
export async function findTripClash(
  {
    vehicleId,
    startAt,
    endAt,
    bufferHours,
  }: { vehicleId: Id; startAt: Date; endAt: Date; bufferHours: number },
  {
    session,
    now = new Date(),
    ignoreBookingId,
  }: { session?: ClientSession; now?: Date; ignoreBookingId?: Id } = {},
): Promise<AvailabilityBlock | null> {
  const ignore = ignoreBookingId ? { bookingId: mongoose.trusted({ $ne: ignoreBookingId }) } : {};
  const trip = await AvailabilityBlockModel.findOne({
    vehicleId,
    ...overlapping(startAt, endAt),
    ...activeBlock(now),
    ...ignore,
  })
    .session(session ?? null)
    .lean();
  if (trip || bufferHours <= 0) return trip;

  return AvailabilityBlockModel.findOne({
    vehicleId,
    reason: mongoose.trusted({ $in: TRIP_REASONS }),
    ...overlapping(endAt, new Date(endAt.getTime() + bufferHours * HOUR_MS)),
    ...activeBlock(now),
    ...ignore,
  })
    .session(session ?? null)
    .lean();
}

export interface TripDates {
  vehicleId: Id;
  bookingId: Id;
  startAt: Date;
  endAt: Date;
  bufferHours: number;
  /** Set for a HOLD (checkout, or a request waiting for the Host); left out for a confirmed booking. */
  holdUntil?: Date;
}

/**
 * Blocks a booking's dates, plus the Host's preparation time after them, inside the caller's
 * transaction. Throws 409 DATES_UNAVAILABLE when they're taken.
 */
export async function reserveTripDates(trip: TripDates, session: ClientSession, now = new Date()) {
  await bumpBookingSeq(trip.vehicleId, session);
  if (await findTripClash(trip, { session, now })) throw datesUnavailable();

  const expiry = trip.holdUntil ? { expiresAt: trip.holdUntil } : {};
  const blocks: Partial<AvailabilityBlock>[] = [
    {
      vehicleId: toId(trip.vehicleId),
      bookingId: toId(trip.bookingId),
      startAt: trip.startAt,
      endAt: trip.endAt,
      reason: trip.holdUntil ? 'HOLD' : 'BOOKED',
      ...expiry,
    },
  ];
  if (trip.bufferHours > 0) {
    blocks.push({
      vehicleId: toId(trip.vehicleId),
      bookingId: toId(trip.bookingId),
      startAt: trip.endAt,
      endAt: new Date(trip.endAt.getTime() + trip.bufferHours * HOUR_MS),
      reason: 'BUFFER',
      ...expiry,
    });
  }
  await AvailabilityBlockModel.insertMany(blocks, { session });
}

/** A request waiting for the Host keeps its dates for up to 24 hours (plan §8.2). */
export async function extendTripHold(bookingId: Id, until: Date, session: ClientSession) {
  await AvailabilityBlockModel.updateMany({ bookingId }, { $set: { expiresAt: until } }, { session });
}

/** A confirmed booking's HOLD becomes BOOKED, and its dates are kept for good. */
export async function confirmTripDates(bookingId: Id, session: ClientSession) {
  await AvailabilityBlockModel.updateMany(
    { bookingId, reason: 'HOLD' },
    { $set: { reason: 'BOOKED' }, $unset: { expiresAt: 1 } },
    { session },
  );
  await AvailabilityBlockModel.updateMany(
    { bookingId, reason: 'BUFFER' },
    { $unset: { expiresAt: 1 } },
    { session },
  );
}

/** Frees a booking's dates when it's cancelled, declined or expires. */
export async function releaseTripDates(bookingId: Id, session: ClientSession) {
  await AvailabilityBlockModel.deleteMany({ bookingId }, { session });
}

export interface NewBlock {
  vehicleId: Id;
  startAt: Date;
  endAt: Date;
  reason: 'HOST_BLOCK' | 'ADMIN';
  note?: string;
  createdBy: Id;
}

/**
 * The Host blocks dates, or staff override the calendar (plan §9, Days 10–11). Refused when the
 * range overlaps a booking or a hold: those are cancelled explicitly, never blocked over.
 */
export async function addBlock(block: NewBlock, now = new Date()): Promise<AvailabilityBlockDocument> {
  if (block.endAt <= block.startAt) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      endAt: 'The end needs to be after the start',
    });
  }
  return withTransaction(async (session) => {
    await bumpBookingSeq(block.vehicleId, session);
    const clash = await AvailabilityBlockModel.exists({
      vehicleId: block.vehicleId,
      reason: mongoose.trusted({ $in: TRIP_REASONS }),
      ...overlapping(block.startAt, block.endAt),
      ...activeBlock(now),
    }).session(session);
    if (clash) {
      throw new HttpError(
        409,
        'BOOKED_DATES',
        'Some of those dates are booked or held for a guest. Choose other dates, or cancel the booking first.',
      );
    }
    const [created] = await AvailabilityBlockModel.create(
      [
        {
          vehicleId: block.vehicleId,
          startAt: block.startAt,
          endAt: block.endAt,
          reason: block.reason,
          note: block.note,
          createdBy: block.createdBy,
        },
      ],
      { session },
    );
    return created!;
  });
}

/**
 * Removes a Host block (or, for staff, any block that isn't a trip's). Returns false when there's no
 * such block on this car.
 */
export async function removeBlock(
  vehicleId: Id,
  blockId: string,
  reasons: BlockReason[] = ['HOST_BLOCK'],
): Promise<boolean> {
  if (!mongoose.isValidObjectId(blockId)) return false;
  return withTransaction(async (session) => {
    await bumpBookingSeq(vehicleId, session);
    const result = await AvailabilityBlockModel.deleteOne(
      { _id: blockId, vehicleId, reason: mongoose.trusted({ $in: reasons }) },
      { session },
    );
    return result.deletedCount > 0;
  });
}

export interface TimeRange {
  startAt: Date;
  endAt: Date;
}

/** Parses "HH:mm" into minutes after midnight. */
const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours! * 60 + minutes!;
};

/**
 * The time ranges a car's recurring rules cover between two instants, in NZ time. A rule whose end
 * is at or before its start runs overnight into the next day, so 00:00–00:00 covers whole days.
 */
export function expandRecurringRules(
  rules: Pick<RecurringRule, 'daysOfWeek' | 'startTime' | 'endTime'>[],
  from: Date,
  until: Date,
): TimeRange[] {
  const ranges: TimeRange[] = [];
  // Start a day early, so an overnight rule from the day before is included.
  for (let day = addNzDays(startOfNzDay(from), -1); day < until; day = addNzDays(day, 1)) {
    const { year, month, day: date, weekday } = toNzWallClock(day);
    for (const rule of rules) {
      if (!rule.daysOfWeek.includes(weekday)) continue;
      const start = minutesOf(rule.startTime);
      const end = minutesOf(rule.endTime);
      const startAt = fromNzWallClock(year, month, date, Math.floor(start / 60), start % 60);
      const endDay = end <= start ? addNzDays(day, 1) : day;
      const endClock = toNzWallClock(endDay);
      const endAt = fromNzWallClock(
        endClock.year,
        endClock.month,
        endClock.day,
        Math.floor(end / 60),
        end % 60,
      );
      if (endAt > from && startAt < until) ranges.push({ startAt, endAt });
    }
  }
  return ranges.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

export interface RecurringResult {
  /** How many blocks the rules now cover over the next 12 months. */
  blocks: number;
  /** Ranges left open because a booking or hold is already there (plan §3: rules never override one). */
  skipped: TimeRange[];
}

/**
 * Rebuilds a car's RECURRING blocks for the next 12 months from its rules (plan §3, recurring
 * availability). Blocks already in progress stay; ranges that overlap a booking or hold are skipped.
 */
export async function rebuildRecurringBlocks(vehicleId: Id, now = new Date()): Promise<RecurringResult> {
  return withTransaction(async (session) => {
    const vehicle = await VehicleModel.findByIdAndUpdate(
      vehicleId,
      { $inc: { bookingSeq: 1 } },
      { session, new: true, projection: { recurringRules: 1 } },
    );
    if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'No car with that id.');

    await AvailabilityBlockModel.deleteMany(
      { vehicleId, reason: 'RECURRING', startAt: mongoose.trusted({ $gte: now }) },
      { session },
    );
    const until = addNzDays(now, RECURRING_MONTHS * 31);
    const ranges = expandRecurringRules(vehicle.recurringRules, now, until).filter(
      (range) => range.startAt >= now,
    );
    if (ranges.length === 0) return { blocks: 0, skipped: [] };

    const trips = await AvailabilityBlockModel.find({
      vehicleId,
      reason: mongoose.trusted({ $in: TRIP_REASONS }),
      ...overlapping(now, until),
      ...activeBlock(now),
    })
      .session(session)
      .select('startAt endAt')
      .lean();
    const clashes = (range: TimeRange) =>
      trips.some((trip) => trip.startAt < range.endAt && trip.endAt > range.startAt);

    const kept = ranges.filter((range) => !clashes(range));
    await AvailabilityBlockModel.insertMany(
      kept.map((range) => ({ vehicleId: toId(vehicleId), ...range, reason: 'RECURRING' })),
      { session },
    );
    return { blocks: kept.length, skipped: ranges.filter(clashes) };
  });
}

/** Cars with any block in the range, for search to leave out (plan §3, Key rules: location search). */
export function unavailableVehicleIds(
  startAt: Date,
  endAt: Date,
  now = new Date(),
): Promise<Types.ObjectId[]> {
  return AvailabilityBlockModel.distinct('vehicleId', {
    ...overlapping(startAt, endAt),
    ...activeBlock(now),
  });
}

/** A car's blocks between two instants, for the Host calendar (with reasons and bookings). */
export function calendarBlocks(vehicleId: Id, from: Date, to: Date, now = new Date()) {
  return AvailabilityBlockModel.find({ vehicleId, ...overlapping(from, to), ...activeBlock(now) })
    .sort({ startAt: 1 })
    .lean();
}

/**
 * When a car is busy, for the public listing calendar: the blocks merged into ranges, with no
 * reasons (a Guest never learns why a date is taken).
 */
export async function busyRanges(
  vehicleId: Id,
  from: Date,
  to: Date,
  now = new Date(),
): Promise<TimeRange[]> {
  const blocks = await calendarBlocks(vehicleId, from, to, now);
  const merged: TimeRange[] = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (last && block.startAt <= last.endAt) {
      if (block.endAt > last.endAt) last.endAt = block.endAt;
    } else {
      merged.push({ startAt: block.startAt, endAt: block.endAt });
    }
  }
  return merged;
}

const toId = (id: Id) => (typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id);
