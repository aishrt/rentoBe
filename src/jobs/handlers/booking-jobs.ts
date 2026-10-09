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
import { notify } from '../../modules/notifications/notify.js';
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
 * suspended meanwhile (`CAR_UNAVAILABLE`); an authorisation is released instead of refunded.
 */
export async function refundUnwantedJob(
  { paymentId, reason }: { paymentId: string; reason?: UnwantedReason },
  { log }: JobContext,
) {
  const payment = await PaymentModel.findById(paymentId);
  if (!payment || payment.refunds.length > 0) return;
  if (payment.status !== 'SUCCEEDED' && !(payment.status === 'AUTHORISED' && reason)) return;
  const booking = await BookingModel.findById(payment.bookingId)
    .select('status ref guestId vehicleSnapshot.title startAt statusHistory.status')
    .lean();
  if (!booking || !['EXPIRED', 'CANCELLED', 'DECLINED'].includes(booking.status)) return;
  // A booking that was confirmed and then cancelled refunded what its policy gives; nothing more here.
  if (booking.statusHistory.some((change) => change.status === 'CONFIRMED')) return;
  const guest = await UserModel.findById(booking.guestId).select('firstName').lean();
  const tripUrl = `${env.FRONTEND_URL.replace(/\/+$/, '')}/trips/${booking.ref}`;
  const takenParagraph =
    reason === 'CAR_UNAVAILABLE'
      ? `The ${booking.vehicleSnapshot.title} was taken off Rento Vroom while your payment was still being processed, so booking ${booking.ref} for ${formatNzDateTime(booking.startAt)} wasn’t made.`
      : `The dates for ${booking.vehicleSnapshot.title} from ${formatNzDateTime(booking.startAt)} were booked by someone else while your payment was still being processed by your bank, so booking ${booking.ref} wasn’t made.`;
  const shortWhy =
    reason === 'CAR_UNAVAILABLE'
      ? 'The car was taken off Rento Vroom while your payment was processing'
      : 'The dates were taken while your payment was processing';

  if (payment.status === 'AUTHORISED') {
    // Only authorised: nothing was taken, and the hold on the card is released.
    await cancelIntent(payment);
    await PaymentModel.updateOne(
      { _id: payment._id, status: 'AUTHORISED' },
      { $set: { status: 'CANCELLED' } },
    );
    await notify({
      userId: booking.guestId,
      type: 'BOOKING_EXPIRED',
      title: `Booking ${booking.ref} wasn’t made`,
      body: `${shortWhy}. The hold on your card is released.`,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'tripNotice',
        props: {
          firstName: guest?.firstName ?? 'there',
          heading: `Booking ${booking.ref} wasn’t made`,
          paragraphs: [
            takenParagraph,
            'Nothing was charged: the hold on your card is released, and your bank removes it within a few days. Sorry about that. Please choose other dates or another car.',
          ],
          buttonLabel: 'Find another car',
          url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/search`,
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
    if (!fresh || fresh.refunds.length > 0) return;
    fresh.refunds.push({
      amountCents: refund.amountCents,
      reason:
        reason === 'DATES_TAKEN'
          ? 'The dates were booked by someone else while the payment was processing'
          : reason === 'CAR_UNAVAILABLE'
            ? 'The car was suspended while the payment was processing'
            : 'Paid after the booking had ended',
      kind: 'LATE_PAYMENT',
      fundedBy: 'PLATFORM',
      stripeRefundId: refund.stripeRefundId,
      status: refund.status,
      createdAt: new Date(),
    });
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
        body: reason
          ? `${shortWhy}, so nothing was booked.`
          : 'Your payment went through after the booking had ended, so nothing was booked.',
        link: `/trips/${booking.ref}`,
        email: reason
          ? {
              template: 'tripNotice',
              props: {
                firstName: guest?.firstName ?? 'there',
                heading: `${amount} refunded: booking ${booking.ref} wasn’t made`,
                paragraphs: [
                  takenParagraph,
                  `We’ve refunded all ${amount} NZD to the card you paid with. It usually reaches your account within 5–10 business days. Sorry about that.`,
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
  log.warn({ paymentId, bookingStatus: booking.status }, 'Refunded a payment made after its booking ended');
}

/** `risk.paymentCheck`: the card's country and Stripe Radar's verdict on a payment (plan §14). */
export async function paymentRiskCheckJob({ paymentId }: { paymentId: string }, { log }: JobContext) {
  await checkPaymentRisk(paymentId);
  log.info({ paymentId }, 'Payment risk checked');
}
