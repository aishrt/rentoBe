import type { ClientSession } from 'mongoose';
import { cancelJobs, enqueue } from '../../jobs/queue.js';
import type { JobType } from '../../jobs/handlers/index.js';
import type { BookingRecord } from './booking-view.js';

/*
 * The jobs a confirmed trip runs on (plan §4.3): pickup reminders 24 h and 2 h before, a return
 * reminder 2 h before the end, and the checks for a missing check-in and a late return. They're queued
 * when the booking is confirmed and cancelled with it.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Every job a booking's trip queues, for cancelling them together. */
export const TRIP_JOBS = [
  'reminder.pickup',
  'reminder.return',
  'trip.startCheck',
  'trip.returnCheck',
] as const satisfies readonly JobType[];

/** A trip confirmed this close to its start gets its pickup reminder straight away (plan §7). */
export const LAST_MINUTE_HOURS = 3;

/** Whether a trip starts within 3 hours of `now`, so its pickup reminder and texts can't wait. */
export const isLastMinute = (startAt: Date, now = new Date()) =>
  startAt.getTime() > now.getTime() && startAt.getTime() - now.getTime() <= LAST_MINUTE_HOURS * HOUR_MS;

/**
 * Queues the trip's reminders and checks. One that would already be due is left out; a trip confirmed
 * within 3 hours of its start gets one pickup reminder straight away instead.
 */
export async function scheduleTripJobs(booking: BookingRecord, session: ClientSession, now = new Date()) {
  const start = booking.startAt.getTime();
  const end = booking.endAt.getTime();
  const id = booking._id.toString();
  const lastMinute = isLastMinute(booking.startAt, now);
  const jobs = [
    { type: 'reminder.pickup', hours: 24, runAt: start - 24 * HOUR_MS },
    { type: 'reminder.pickup', hours: 2, runAt: start - 2 * HOUR_MS },
    { type: 'reminder.return', hours: 2, runAt: end - 2 * HOUR_MS },
  ] as const;
  for (const job of jobs) {
    if (job.runAt <= now.getTime() || (lastMinute && job.type === 'reminder.pickup')) continue;
    await enqueue(
      job.type,
      { bookingId: id, hoursBefore: job.hours },
      { runAt: new Date(job.runAt), uniqueKey: `${job.type}:${job.hours}:${id}`, refId: id, session },
    );
  }
  if (lastMinute) {
    // "In 2 hours" and so on, to the nearest hour.
    const hoursBefore = Math.max(1, Math.round((start - now.getTime()) / HOUR_MS));
    await enqueue(
      'reminder.pickup',
      { bookingId: id, hoursBefore },
      { runAt: now, uniqueKey: `reminder.pickup:last-minute:${id}`, refId: id, session },
    );
  }
  // A missing check-in: both parties reminded after 1 h, support alerted after 2 h (plan §8.2).
  for (const hoursAfter of [1, 2]) {
    await enqueue(
      'trip.startCheck',
      { bookingId: id, hoursAfter },
      {
        runAt: new Date(Math.max(start + hoursAfter * HOUR_MS, now.getTime())),
        uniqueKey: `trip.startCheck:${hoursAfter}:${id}`,
        refId: id,
        session,
      },
    );
  }
}

/**
 * A check-in done after the start time, which the other party hasn't confirmed yet: the start checks for it
 * (a reminder to confirm after 1 h, support alerted after 2 h) run from the check-in instead, as those
 * queued from the start have run already or would come too soon (plan §8.2).
 */
export async function scheduleLateCheckInChecks(
  booking: BookingRecord,
  session: ClientSession,
  now = new Date(),
) {
  if (now.getTime() <= booking.startAt.getTime()) return;
  const id = booking._id.toString();
  await cancelJobs(id, ['trip.startCheck'], session);
  for (const hoursAfter of [1, 2]) {
    await enqueue(
      'trip.startCheck',
      { bookingId: id, hoursAfter },
      {
        runAt: new Date(now.getTime() + hoursAfter * HOUR_MS),
        uniqueKey: `trip.startCheck:${hoursAfter}:checked-in:${id}`,
        refId: id,
        session,
      },
    );
  }
}
