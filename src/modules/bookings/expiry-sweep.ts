import mongoose from 'mongoose';
import { logger } from '../../integrations/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { formatNzDateTime } from '../../lib/format.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { BookingModel } from './booking.model.js';
import { expirePaymentHold, expireRequest } from './booking.service.js';

/*
 * The safety net for `booking.expireRequest` and `booking.expirePaymentHold` (plan §4.3). Each runs when
 * its booking's time is up, and the queue gives up after its retries (plan §4.2): through a long Stripe
 * outage, or a payment still processing at the bank, the booking would stay waiting for good with the
 * Guest's card held. Every hour, the requests and payment holds still waiting past their time end here.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A booking's own job, and its first retries, run before the sweep steps in. */
const GRACE_MS = 15 * MINUTE_MS;
/** Still waiting this long past its time, after several sweeps: staff are told, once. */
const ALERT_AFTER_MS = 6 * HOUR_MS;
/** The most of each kind one run takes on, oldest first: a backlog after a long outage takes a few runs. */
const BATCH = 100;

/** The next whole hour. NZ time is a whole number of hours ahead of UTC, so it's on the hour there too. */
const nextHour = (now: Date) => new Date((Math.floor(now.getTime() / HOUR_MS) + 1) * HOUR_MS);

export async function scheduleBookingExpirySweep(now = new Date()) {
  const runAt = nextHour(now);
  await enqueue(
    'hourly.bookingExpiry',
    {},
    { runAt, uniqueKey: `hourly.bookingExpiry:${runAt.toISOString()}` },
  );
}

export interface ExpirySweepResult {
  /** Requests and payment holds ended. */
  expired: number;
  /** Ones that couldn't be ended this time (Stripe down, a payment processing): tried again next hour. */
  failed: number;
}

/**
 * `hourly.bookingExpiry`: ends each request and payment hold still waiting past its time, as its own job
 * would have. One that fails is logged and left for the next sweep; the others still go ahead.
 */
export async function sweepExpiredBookings(now = new Date()): Promise<ExpirySweepResult> {
  await scheduleBookingExpirySweep(now);
  const cutoff = new Date(now.getTime() - GRACE_MS);
  const requests = await BookingModel.find({
    status: 'PENDING',
    requestExpiresAt: mongoose.trusted({ $lte: cutoff }),
  })
    .select('_id ref requestExpiresAt')
    .sort({ requestExpiresAt: 1 })
    .limit(BATCH)
    .lean();
  const holds = await BookingModel.find({
    status: 'PAYMENT_PENDING',
    holdExpiresAt: mongoose.trusted({ $lte: cutoff }),
  })
    .select('_id ref holdExpiresAt')
    .sort({ holdExpiresAt: 1 })
    .limit(BATCH)
    .lean();

  const overdue = [
    ...requests.map((booking) => ({
      booking,
      due: booking.requestExpiresAt!,
      end: () => expireRequest(booking._id.toString(), now),
    })),
    ...holds.map((booking) => ({
      booking,
      due: booking.holdExpiresAt!,
      end: async () => (await expirePaymentHold(booking._id.toString(), now)) === 'expired',
    })),
  ];
  const result: ExpirySweepResult = { expired: 0, failed: 0 };
  for (const { booking, due, end } of overdue) {
    try {
      if (await end()) result.expired += 1;
    } catch (error) {
      result.failed += 1;
      const bookingId = booking._id.toString();
      logger.warn(
        { err: error, bookingId },
        'Could not end a booking past its expiry; trying again next hour',
      );
      if (now.getTime() - due.getTime() < ALERT_AFTER_MS) continue;
      const message = error instanceof Error ? error.message : String(error);
      await alertStaff({
        type: 'BOOKING_EXPIRY_STUCK',
        title: `Booking ${booking.ref} is still waiting past its expiry`,
        body: `Booking ${booking.ref} should have expired at ${formatNzDateTime(due)} (NZ time), but it couldn't be ended (the last error: "${message}"). It's tried again every hour; if it doesn't clear, check the guest's payment in Stripe.`,
        link: `/admin/bookings/${booking.ref}`,
        dedupeKey: `BOOKING_EXPIRY_STUCK:${bookingId}`,
      }).catch((alertError: unknown) => {
        logger.warn({ err: alertError, bookingId }, 'Could not alert staff to a booking past its expiry');
      });
    }
  }
  return result;
}
