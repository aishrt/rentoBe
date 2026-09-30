import mongoose, { type ClientSession, type Types } from 'mongoose';
import { cancelJobs, enqueue } from '../../jobs/queue.js';
import { confirmTripDates, extendTripHold, releaseTripDates } from '../availability/availability.service.js';
import type { PaymentDocument } from '../payments/payment.model.js';
import {
  BookingModel,
  type BookingDocument,
  type BookingStatus,
  type CancellationReason,
} from './booking.model.js';
import { notifyConfirmed, notifyRequestReceived } from './booking-notifications.js';
import { loadBookingContext, type BookingRecord } from './booking-view.js';

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
  await notifyConfirmed(record(confirmed), await loadBookingContext(record(confirmed)), { session });
  return confirmed;
}

/** The card is authorised for a request (or a booking waiting for verification): the Host has 24 h. */
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
  await notifyRequestReceived(record(pending), await loadBookingContext(record(pending)), { session });
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
  await cancelJobs(booking.id, [...EXPIRY_JOBS], session);
  return ended;
}
