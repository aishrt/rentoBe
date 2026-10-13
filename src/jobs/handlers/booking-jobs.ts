import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { stripe } from '../../integrations/stripe.js';
import { formatNzDateTime, formatNzdExact } from '../../lib/format.js';
import { getPlatformSettings } from '../../modules/admin/platform-settings.service.js';
import { BookingModel } from '../../modules/bookings/booking.model.js';
import {
  cancelIntent,
  refundIntent,
  statusAfterRefunds,
  type UnwantedReason,
} from '../../modules/bookings/booking-payments.js';
import { expirePaymentHold, expireRequest } from '../../modules/bookings/booking.service.js';
import { recordStripeRefunds } from '../../modules/bookings/payment-events.js';
import { notify } from '../../modules/notifications/notify.js';
import { refundCancelledCharge } from '../../modules/payments/extra-charges.service.js';
import { PaymentModel } from '../../modules/payments/payment.model.js';
import { checkPaymentRisk } from '../../modules/risk/risk-signals.js';
import { UserModel } from '../../modules/users/user.model.js';
import { enqueue } from '../queue.js';
import type { JobContext } from './index.js';

/*
 * Booking jobs (plan §4.3). Each checks the booking's current state first, so a retry or a job that
 * runs after the booking moved on does nothing.
 */

/** `booking.expirePaymentHold`: 30 minutes after a booking is created without payment. */
export async function expirePaymentHoldJob({ bookingId }: { bookingId: string }, { log }: JobContext) {
  const result = await expirePaymentHold(bookingId);
  if (result === 'waiting') {
    // The payment is still processing at the bank: check again shortly.
    const runAt = new Date(Date.now() + 5 * 60_000);
    await enqueue(
      'booking.expirePaymentHold',
      { bookingId },
      { runAt, uniqueKey: `expire-hold:${bookingId}:${runAt.getTime()}`, refId: bookingId },
    );
  }
  log.info({ bookingId, result }, 'Payment hold checked');
}

/** `booking.expireRequest`: 24 hours after a request without the Host's answer. */
export async function expireRequestJob({ bookingId }: { bookingId: string }, { log }: JobContext) {
  const expired = await expireRequest(bookingId);
  log.info({ bookingId, expired }, 'Booking request checked');
}

/** How the Guest paid, for the receipt: "Visa ending 4242", "Apple Pay (Visa ending 4242)". */
function methodLabel(charge: Stripe.Charge | null): string {
  const card = charge?.payment_method_details?.card;
  if (!card) return 'card';
  const brand = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card';
  const base = `${brand} ending ${card.last4 ?? '••••'}`;
  const wallet = card.wallet?.type;
  if (wallet === 'apple_pay') return `Apple Pay (${base})`;
  if (wallet === 'google_pay') return `Google Pay (${base})`;
  return base;
}

/** `payment.receipt`: the payment receipt with GST (plan §8.1, item 18), once a booking is confirmed. */
export async function paymentReceiptJob({ paymentId }: { paymentId: string }, { log }: JobContext) {
  const payment = await PaymentModel.findById(paymentId);
  if (!payment || payment.status !== 'SUCCEEDED') return;
  const booking = await BookingModel.findById(payment.bookingId).lean();
  if (!booking) return;
  const guest = await UserModel.findById(booking.guestId).select('firstName').lean();

  let paidAt = payment.updatedAt;
  let method = payment.method ?? 'card';
  try {
    const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId, {
      expand: ['latest_charge'],
    });
    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    method = methodLabel(charge);
    if (charge?.created) paidAt = new Date(charge.created * 1000);
    if (payment.method !== method) {
      payment.method = method;
      await payment.save();
    }
  } catch (error) {
    // The receipt still goes out without the card details.
    log.warn({ err: error, paymentId }, 'Could not read the charge for the receipt');
  }

  const settings = await getPlatformSettings();
  await notify({
    userId: booking.guestId,
    type: 'PAYMENT_RECEIPT',
    title: `Receipt for ${booking.ref}`,
    body: `${formatNzdExact(booking.price.totalCents)} paid by ${method}.`,
    link: `/trips/${booking.ref}`,
    email: {
      template: 'paymentReceipt',
      props: {
        firstName: guest?.firstName ?? 'there',
        ref: booking.ref,
        vehicleTitle: booking.vehicleSnapshot.title,
        start: formatNzDateTime(booking.startAt),
        end: formatNzDateTime(booking.endAt),
        paidAt: formatNzDateTime(paidAt),
        method,
        lines: booking.lineItems.map((item) => ({
          label: item.label,
          amount: formatNzdExact(item.amountCents),
        })),
        total: formatNzdExact(booking.price.totalCents),
        gst: formatNzdExact(booking.price.gstCents),
        legalName: settings.business.legalName,
        ...(settings.business.gstNumber && { gstNumber: settings.business.gstNumber }),
        url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/trips/${booking.ref}`,
      },
    },
    dedupeKey: `PAYMENT_RECEIPT:${paymentId}`,
  });
}

/**
 * `payment.refundUnwanted`: a payment that went through after its booking had ended is refunded in full,
 * and the Guest is told why. With a reason, the payment went through but its booking couldn't be made
 * (plan §8.2): the dates were booked by someone else after its hold ran out (`DATES_TAKEN`), or the car was
 * suspended meanwhile (`CAR_UNAVAILABLE`); or it was a second payment for a booking another one had already
 * made (`DUPLICATE`). What's done follows Stripe, not our record, which may say cancelled for a payment Stripe
 * took as its booking ended (plan §8.1, item 14): money taken is refunded, an authorisation released.
 */
export async function refundUnwantedJob(
  { paymentId, reason }: { paymentId: string; reason?: UnwantedReason },
  { log }: JobContext,
) {
  if (reason === 'CHARGE_CANCELLED') {
    if (await refundCancelledCharge(paymentId)) log.warn({ paymentId }, 'Refunded a cancelled extra charge');
    return;
  }
  const payment = await PaymentModel.findById(paymentId);
  if (!payment || payment.refunds.length > 0) return;
  const booking = await BookingModel.findById(payment.bookingId)
    .select('status ref guestId vehicleSnapshot.title startAt statusHistory.status')
    .lean();
  if (!booking) return;
  if (reason === 'DUPLICATE') {
    // Only ever a second payment: the one that made the booking stays.
    const made = await PaymentModel.exists({
      bookingId: payment.bookingId,
      type: 'BOOKING',
      _id: mongoose.trusted({ $ne: payment._id }),
      status: mongoose.trusted({ $in: ['AUTHORISED', 'SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }),
    });
    if (!made) return;
  } else {
    if (!['EXPIRED', 'CANCELLED', 'DECLINED'].includes(booking.status)) return;
    // A booking that was confirmed and then cancelled refunded what its policy gives; nothing more here.
    if (booking.statusHistory.some((change) => change.status === 'CONFIRMED')) return;
  }
  const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
  // The bank is still deciding: try again later (the job's retries back off).
  if (intent.status === 'processing') throw new Error(`Payment ${paymentId} is still processing at the bank`);
  if (intent.status !== 'succeeded' && intent.status !== 'requires_capture') return;

  const guest = await UserModel.findById(booking.guestId).select('firstName').lean();
  const tripUrl = `${env.FRONTEND_URL.replace(/\/+$/, '')}/trips/${booking.ref}`;
  const takenParagraph =
    reason === 'DUPLICATE'
      ? `Booking ${booking.ref} for the ${booking.vehicleSnapshot.title} was already paid for when a second payment for it went through.`
      : reason === 'CAR_UNAVAILABLE'
        ? `The ${booking.vehicleSnapshot.title} was taken off Rento Vroom while your payment was still being processed, so booking ${booking.ref} for ${formatNzDateTime(booking.startAt)} wasn’t made.`
        : `The dates for ${booking.vehicleSnapshot.title} from ${formatNzDateTime(booking.startAt)} were booked by someone else while your payment was still being processed by your bank, so booking ${booking.ref} wasn’t made.`;
  const shortWhy =
    reason === 'DUPLICATE'
      ? `Booking ${booking.ref} was already paid for`
      : reason === 'CAR_UNAVAILABLE'
        ? 'The car was taken off Rento Vroom while your payment was processing'
        : reason
          ? 'The dates were taken while your payment was processing'
          : 'The booking had ended before your payment went through';

  if (intent.status === 'requires_capture') {
    // Only authorised: nothing was taken, and the hold on the card is released.
    await cancelIntent(payment);
    await PaymentModel.updateOne(
      { _id: payment._id, status: mongoose.trusted({ $in: ['PENDING', 'AUTHORISED'] }) },
      { $set: { status: 'CANCELLED' } },
    );
    await notify({
      userId: booking.guestId,
      type: reason === 'DUPLICATE' ? 'PAYMENT_RELEASED' : 'BOOKING_EXPIRED',
      title:
        reason === 'DUPLICATE'
          ? `A second hold for ${booking.ref} is released`
          : `Booking ${booking.ref} wasn’t made`,
      body: `${shortWhy}. The hold on your card is released.`,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'tripNotice',
        props: {
          firstName: guest?.firstName ?? 'there',
          heading:
            reason === 'DUPLICATE'
              ? `A second hold for booking ${booking.ref} is released`
              : `Booking ${booking.ref} wasn’t made`,
          paragraphs: [
            takenParagraph,
            reason === 'DUPLICATE'
              ? 'Nothing more was charged: the second hold on your card is released, and your bank removes it within a few days. Your booking isn’t affected.'
              : 'Nothing was charged: the hold on your card is released, and your bank removes it within a few days. Sorry about that. Please choose other dates or another car.',
          ],
          ...(reason === 'DUPLICATE'
            ? { buttonLabel: 'View the booking', url: tripUrl }
            : { buttonLabel: 'Find another car', url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/search` }),
        },
      },
      dedupeKey: `BOOKING_EXPIRED:${paymentId}:unwanted`,
    });
    log.warn({ paymentId, reason }, 'Released an authorisation whose booking could not be made');
    return;
  }

  const refund = await refundIntent(payment, payment.amountCents, `refund-${payment.id}-unwanted`);
  await withTransaction(async (session) => {
    const fresh = await PaymentModel.findById(payment._id).session(session);
    if (!fresh || fresh.refunds.some((item) => item.stripeRefundId !== refund.stripeRefundId)) return;
    // Recorded already from Stripe's webhook if this transaction failed the first time (plan §8.1, item 13).
    fresh.refunds = fresh.refunds.filter((item) => item.stripeRefundId !== refund.stripeRefundId);
    fresh.refunds.push({
      amountCents: refund.amountCents,
      reason:
        reason === 'DATES_TAKEN'
          ? 'The dates were booked by someone else while the payment was processing'
          : reason === 'CAR_UNAVAILABLE'
            ? 'The car was suspended while the payment was processing'
            : reason === 'DUPLICATE'
              ? 'A second payment for a booking already paid for'
              : 'Paid after the booking had ended',
      kind: 'LATE_PAYMENT',
      fundedBy: 'PLATFORM',
      stripeRefundId: refund.stripeRefundId,
      status: refund.status,
      createdAt: new Date(),
    });
    // A payment we'd recorded as cancelled was taken all the same: it's refunded now.
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(fresh.status)) fresh.status = 'SUCCEEDED';
    fresh.status = statusAfterRefunds(fresh);
    await fresh.save({ session });
    // A refund Stripe refused at once alerted staff (refundIntent), who return the money another way.
    if (refund.status === 'FAILED') return;
    const amount = formatNzdExact(refund.amountCents);
    await notify(
      {
        userId: booking.guestId,
        type: 'REFUND_ISSUED',
        title: `${amount} refunded`,
        body:
          reason === 'DUPLICATE'
            ? `${shortWhy}, so your second payment is refunded. Your booking isn’t affected.`
            : reason
              ? `${shortWhy}, so nothing was booked.`
              : 'Your payment went through after the booking had ended, so nothing was booked.',
        link: `/trips/${booking.ref}`,
        email: reason
          ? {
              template: 'tripNotice',
              props: {
                firstName: guest?.firstName ?? 'there',
                heading:
                  reason === 'DUPLICATE'
                    ? `${amount} refunded: you paid twice for booking ${booking.ref}`
                    : `${amount} refunded: booking ${booking.ref} wasn’t made`,
                paragraphs: [
                  takenParagraph,
                  reason === 'DUPLICATE'
                    ? `We’ve refunded the second payment, all ${amount} NZD, to the card you paid with. It usually reaches your account within 5–10 business days. Your booking isn’t affected.`
                    : `We’ve refunded all ${amount} NZD to the card you paid with. It usually reaches your account within 5–10 business days. Sorry about that.`,
                ],
                buttonLabel: 'View the booking',
                url: tripUrl,
              },
            }
          : {
              template: 'refundIssued',
              props: {
                firstName: guest?.firstName ?? 'there',
                ref: booking.ref,
                vehicleTitle: booking.vehicleSnapshot.title,
                amount,
                url: tripUrl,
                afterBookingEnded: true,
              },
            },
        dedupeKey: `REFUND_ISSUED:${paymentId}:unwanted`,
      },
      { session },
    );
  });
  log.warn({ paymentId, reason, bookingStatus: booking.status }, 'Refunded a payment that made no booking');
}

/**
 * `payment.syncRefunds`: Stripe has refunded more of a payment than is recorded here (plan §8.1, item 13):
 * the refunds missing are recorded from Stripe's list, and staff are asked to check them.
 */
export async function syncRefundsJob({ paymentId }: { paymentId: string }, { log }: JobContext) {
  const payment = await PaymentModel.findById(paymentId).select('stripePaymentIntentId').lean();
  if (!payment) return;
  const refunds = await stripe().refunds.list({ payment_intent: payment.stripePaymentIntentId, limit: 100 });
  const recorded = await withTransaction((session) => recordStripeRefunds(paymentId, refunds.data, session));
  if (recorded > 0) log.warn({ paymentId, recorded }, 'Recorded refunds made in Stripe');
}

/** `risk.paymentCheck`: the card's country and Stripe Radar's verdict on a payment (plan §14). */
export async function paymentRiskCheckJob({ paymentId }: { paymentId: string }, { log }: JobContext) {
  await checkPaymentRisk(paymentId);
  log.info({ paymentId }, 'Payment risk checked');
}
