import mongoose, { type ClientSession, type Types } from 'mongoose';
import { cancelJobs, enqueue } from '../../jobs/queue.js';
import { formatNzDateTime } from '../../lib/format.js';
import { confirmTripDates, extendTripHold, releaseTripDates } from '../availability/availability.service.js';
import type { PaymentDocument } from '../payments/payment.model.js';
import {
  BookingModel,
  type BookingDocument,
  type BookingStatus,
  type CancellationReason,
} from './booking.model.js';
import { postSystemMessage } from '../messages/thread-core.js';
import { ThreadModel } from '../messages/thread.model.js';
import { replaceTripPayout, scheduleTripPayout } from '../payouts/payouts.service.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { notifyConfirmed, notifyRequestReceived } from './booking-notifications.js';
import { hostAnswers, loadBookingContext, type BookingRecord } from './booking-view.js';
import { TRIP_JOBS, scheduleTripJobs } from './trip-jobs.js';

/*
 * Every booking status change goes through here, inside a transaction, and is recorded in
 * statusHistory (plan §8.2). The calendar, the jobs and the notifications change in the same
 * transaction, so a booking is never confirmed without its dates, or cancelled with its reminders.
 */

const HOUR_MS = 60 * 60 * 1000;
/** A request waits up to 24 hours for the Host (plan §8.1, item 5). */
export const REQUEST_HOURS = 24;

const EXPIRY_JOBS = ['booking.expirePaymentHold', 'booking.expireRequest'] as const;

/**
 * Moves a booking from one of `from` to `to`. Resolves null when it's no longer in one of `from`
 * (another request or job got there first), so every caller is safe to repeat.
 */
export async function transition(
  bookingId: Types.ObjectId,
  from: BookingStatus[],
  to: BookingStatus,
  session: ClientSession,
  {
    set = {},
    by,
    reason,
    now = new Date(),
  }: { set?: Record<string, unknown>; by?: Types.ObjectId | string; reason?: string; now?: Date } = {},
): Promise<BookingDocument | null> {
  return BookingModel.findOneAndUpdate(
    { _id: bookingId, status: mongoose.trusted({ $in: from }) },
    {
      $set: { status: to, ...set },
      $push: { statusHistory: { status: to, at: now, ...(by && { by }), ...(reason && { reason }) } },
    },
    { new: true, session },
  );
}

const record = (booking: BookingDocument) => booking.toObject() as BookingRecord;

/** Paid (Instant Book) or captured (a request the Host accepted): the booking is confirmed. */
export async function confirmBooking(
  booking: BookingDocument,
  payment: PaymentDocument,
  session: ClientSession,
  now = new Date(),
) {
  const confirmed = await transition(booking._id, ['PAYMENT_PENDING', 'PENDING'], 'CONFIRMED', session, {
    now,
  });
  if (!confirmed) return null;
  await confirmTripDates(booking._id, session);
  await cancelJobs(booking.id, [...EXPIRY_JOBS], session);
  await enqueue(
    'payment.receipt',
    { paymentId: payment.id },
    { uniqueKey: `receipt:${payment.id}`, refId: booking.id, session },
  );
  await scheduleTripJobs(record(confirmed), session, now);
  await scheduleTripPayout(record(confirmed), session, now);
  await notifyConfirmed(record(confirmed), await loadBookingContext(record(confirmed)), { session });
  await postSystemMessage(
    confirmed,
    `Booking confirmed: ${formatNzDateTime(confirmed.startAt)} to ${formatNzDateTime(confirmed.endAt)} (NZ time). The exact pick-up address and each other's mobile number are on the booking now.`,
    { session, now },
  );
  return confirmed;
}

/**
 * The card is authorised for a request, or for a booking whose Guest's verification is in review:
 * 24 h for the Host to answer, for support to approve the check, or both (plan §8.2).
 */
export async function markRequested(booking: BookingDocument, session: ClientSession, now = new Date()) {
  const requestExpiresAt = new Date(now.getTime() + REQUEST_HOURS * HOUR_MS);
  const pending = await transition(booking._id, ['PAYMENT_PENDING'], 'PENDING', session, {
    set: { requestExpiresAt },
    now,
  });
  if (!pending) return null;
  await extendTripHold(booking._id, requestExpiresAt, session);
  await cancelJobs(booking.id, ['booking.expirePaymentHold'], session);
  await enqueue(
    'booking.expireRequest',
    { bookingId: booking.id },
    { runAt: requestExpiresAt, uniqueKey: `expire-request:${booking.id}`, refId: booking.id, session },
  );
  const context = await loadBookingContext(record(pending));
  await notifyRequestReceived(record(pending), context, { session });
  // The Host's to answer: the chat opens with the request (plan §16, item 13).
  if (hostAnswers(pending)) {
    await postSystemMessage(
      pending,
      `Booking request sent. ${context.host?.firstName ?? 'The host'} has until ${formatNzDateTime(requestExpiresAt)} (NZ time) to accept or decline. Contact details are shared once it's confirmed.`,
      { session, now },
    );
  }
  return pending;
}

export interface EndInput {
  to: 'EXPIRED' | 'DECLINED' | 'CANCELLED';
  from: BookingStatus[];
  by?: Types.ObjectId | string;
  reason?: string;
  cancellation?: {
    reason: CancellationReason;
    refundCents: number;
    feeCents: number;
    hostShareCents: number;
    hostFeeCents: number;
  };
  now?: Date;
}

/** Ends a booking: its dates are freed and its expiry jobs cancelled (plan §8.2). */
export async function endBooking(booking: BookingDocument, input: EndInput, session: ClientSession) {
  const now = input.now ?? new Date();
  const ended = await transition(booking._id, input.from, input.to, session, {
    by: input.by,
    reason: input.reason,
    now,
    set: input.cancellation
      ? {
          cancelledAt: now,
          ...(input.by && { cancelledBy: input.by }),
          cancellationReason: input.cancellation.reason,
          refundCents: input.cancellation.refundCents,
          cancellationFeeCents: input.cancellation.feeCents,
          hostShareCents: input.cancellation.hostShareCents,
          hostCancellationFeeCents: input.cancellation.hostFeeCents,
        }
      : {},
  });
  if (!ended) return null;
  await releaseTripDates(booking._id, session);
  await cancelJobs(booking.id, [...EXPIRY_JOBS, ...TRIP_JOBS], session);
  // The trip's payout is cancelled, or replaced by the Host's share of a kept fee (plan §4.2).
  if (input.to === 'CANCELLED') await replaceTripPayout(record(ended), session, now);
  // Into the chat the booking already has; an Instant Book that waited only for support never had one.
  if (await ThreadModel.exists({ bookingId: booking._id }).session(session)) {
    await postSystemMessage(ended, endedMessage(input), { session, now });
  }
  return ended;
}

/** The booking chat's automated line when a booking ends before its trip. */
function endedMessage(input: EndInput): string {
  if (input.to === 'DECLINED') return 'The host declined this request. Nothing was charged.';
  if (input.to === 'EXPIRED') return 'This request expired without being confirmed. Nothing was charged.';
  switch (input.cancellation?.reason) {
    case 'REQUEST_WITHDRAWN':
      return 'The guest withdrew this request. Nothing was charged.';
    case 'GUEST_CANCELLED':
      return 'The guest cancelled this booking.';
    case 'HOST_CANCELLED':
      return 'The host cancelled this booking. The guest gets a full refund.';
    default:
      return 'Rento Vroom support cancelled this booking.';
  }
}

/**
 * Check-in is done: the trip is under way (plan §8.2, CONFIRMED → ACTIVE). The late-return checks are
 * queued: at the return time plus the grace period, and 24 hours later.
 */
export async function startTrip(
  booking: BookingDocument,
  session: ClientSession,
  {
    by,
    graceMinutes,
    reason = 'Check-in done',
    now = new Date(),
  }: { by?: Types.ObjectId | string; graceMinutes: number; reason?: string; now?: Date },
) {
  const started = await transition(booking._id, ['CONFIRMED'], 'ACTIVE', session, { by, now, reason });
  if (!started) return null;
  const id = booking.id as string;
  const end = started.endAt.getTime();
  for (const [stage, runAt] of [
    ['GRACE', end + graceMinutes * 60_000],
    ['DAY', end + 24 * HOUR_MS],
  ] as const) {
    await enqueue(
      'trip.returnCheck',
      { bookingId: id, stage },
      {
        runAt: new Date(Math.max(runAt, now.getTime())),
        uniqueKey: `trip.returnCheck:${stage}:${id}`,
        refId: id,
        session,
      },
    );
  }
  return started;
}

/**
 * Check-out is done, or support completed the trip (plan §8.2, ACTIVE → COMPLETED). The car's and Host's
 * trip counts go up, and the trip's remaining reminders are cancelled.
 */
export async function completeTrip(
  booking: BookingDocument,
  session: ClientSession,
  {
    by,
    reason = 'Check-out done',
    now = new Date(),
  }: { by?: Types.ObjectId | string; reason?: string; now?: Date },
) {
  const completed = await transition(booking._id, ['ACTIVE'], 'COMPLETED', session, { by, now, reason });
  if (!completed) return null;
  await cancelJobs(booking.id, [...TRIP_JOBS], session);
  await VehicleModel.updateOne({ _id: completed.vehicleId }, { $inc: { tripCount: 1 } }, { session });
  await UserModel.updateOne({ _id: completed.hostId }, { $inc: { 'hostProfile.tripCount': 1 } }, { session });
  return completed;
}
