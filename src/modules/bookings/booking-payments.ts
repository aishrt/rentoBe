import mongoose, { type ClientSession } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { CHARGE_CURRENCY, stripe } from '../../integrations/stripe.js';
import { logger } from '../../integrations/logger.js';
import { reportError } from '../../integrations/sentry.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { PaymentModel, type PaymentDocument } from '../payments/payment.model.js';
import { AGREEMENT_VERSIONS } from '../users/agreements.js';
import { UserModel } from '../users/user.model.js';
import { BookingModel, type BookingDocument } from './booking.model.js';
import { notifyPaymentFailed } from './booking-notifications.js';
import { confirmBooking, markRequested } from './booking-transitions.js';
import { loadBookingContext, type BookingRecord } from './booking-view.js';
import type { PaymentSession } from './bookings.schemas.js';

/*
 * Paying for a booking (plan §8.1). The API creates the PaymentIntent in NZD: charged straight away
 * for Instant Book, or authorised only (manual capture) for a request the Host accepts within 24 h.
 * The card is saved for post-trip charges (item 3). The same code applies a PaymentIntent's state
 * whether it arrives by webhook or when the website syncs after Stripe.js confirms, so the booking
 * is confirmed once, whichever is first.
 */

type Intent = Pick<Stripe.PaymentIntent, 'id' | 'status' | 'last_payment_error' | 'amount' | 'metadata'>;

/** The Guest's Stripe customer, created on their first payment (plan §8.1, item 7). */
async function ensureCustomer(userId: string): Promise<string> {
  const user = await UserModel.findById(userId).select('email firstName lastName stripeCustomerId');
  if (!user) throw unauthenticated();
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe().customers.create(
    { email: user.email, name: `${user.firstName} ${user.lastName}`, metadata: { userId: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  await UserModel.updateOne(
    { _id: user._id, stripeCustomerId: mongoose.trusted({ $exists: false }) },
    { $set: { stripeCustomerId: customer.id } },
  );
  return customer.id;
}

const REUSABLE: Stripe.PaymentIntent.Status[] = [
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
];

/**
 * POST /bookings/{id}/payment: records the Guest Agreement (plan §6.1) and returns what Stripe.js
 * needs for the payment step, with the Guest's saved cards. Reuses the booking's unfinished
 * PaymentIntent, so retrying never charges twice.
 */
export async function preparePayment(
  guestId: string,
  booking: BookingDocument,
  ip?: string,
  now = new Date(),
): Promise<PaymentSession> {
  if (booking.status !== 'PAYMENT_PENDING') {
    throw new HttpError(409, 'ALREADY_PAID', 'This booking is already paid for or has ended.');
  }
  if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) {
    throw new HttpError(
      409,
      'HOLD_EXPIRED',
      'We held these dates for 30 minutes and the time is up. Please start again.',
    );
  }

  const user = await UserModel.findById(guestId);
  if (!user) throw unauthenticated();
  if (
    !user.agreements.some(
      (agreement) => agreement.type === 'GUEST' && agreement.version === AGREEMENT_VERSIONS.GUEST,
    )
  ) {
    user.agreements.push({ type: 'GUEST', version: AGREEMENT_VERSIONS.GUEST, acceptedAt: now, ip });
    await user.save();
  }

  const client = stripe();
  const customer = await ensureCustomer(guestId);
  const captureMethod = booking.instantBook ? 'automatic' : 'manual';

  let intent: Stripe.PaymentIntent | undefined;
  const existing = await PaymentModel.findOne({
    bookingId: booking._id,
    type: 'BOOKING',
    status: 'PENDING',
  }).sort({ createdAt: -1 });
  if (existing) {
    const current = await client.paymentIntents.retrieve(existing.stripePaymentIntentId);
    if (REUSABLE.includes(current.status)) intent = current;
  }
  if (!intent) {
    const attempt = await PaymentModel.countDocuments({ bookingId: booking._id, type: 'BOOKING' });
    intent = await client.paymentIntents.create(
      {
        amount: booking.price.totalCents,
        currency: CHARGE_CURRENCY,
        customer,
        capture_method: captureMethod,
        // Saved for extra-kilometre and other post-trip charges, with the consent shown at checkout.
        setup_future_usage: 'off_session',
        automatic_payment_methods: { enabled: true },
        description: `Rento Vroom booking ${booking.ref}: ${booking.vehicleSnapshot.title}`,
        metadata: { purpose: 'booking', bookingId: booking.id, bookingRef: booking.ref },
      },
      { idempotencyKey: `booking-${booking.id}-payment-${attempt + 1}` },
    );
    await PaymentModel.create({
      bookingId: booking._id,
      type: 'BOOKING',
      stripePaymentIntentId: intent.id,
      amountCents: intent.amount,
      status: 'PENDING',
    });
  }

  let customerSessionClientSecret: string | undefined;
  try {
    const session = await client.customerSessions.create({
      customer,
      components: {
        payment_element: {
          enabled: true,
          features: {
            payment_method_redisplay: 'enabled',
            payment_method_allow_redisplay_filters: ['always', 'limited', 'unspecified'],
            payment_method_remove: 'enabled',
          },
        },
      },
    });
    customerSessionClientSecret = session.client_secret;
  } catch (error) {
    // Saved cards are a convenience; paying with a new card still works.
    logger.warn({ err: error }, 'Could not create a Stripe customer session for saved cards');
  }

  return {
    clientSecret: intent.client_secret!,
    ...(customerSessionClientSecret && { customerSessionClientSecret }),
    amountCents: intent.amount,
    currency: CHARGE_CURRENCY,
    captureMethod,
    holdExpiresAt: booking.holdExpiresAt.toISOString(),
  };
}

/**
 * Applies a PaymentIntent's state to its payment and booking, inside the caller's transaction
 * (plan §8.1, items 4 and 14). Safe to run any number of times.
 */
export async function applyPaymentIntent(
  intent: Intent,
  session: ClientSession,
  now = new Date(),
): Promise<void> {
  const payment = await PaymentModel.findOne({ stripePaymentIntentId: intent.id }).session(session);
  if (!payment || payment.type !== 'BOOKING') return;
  const booking = await BookingModel.findById(payment.bookingId).session(session);
  if (!booking) return;

  switch (intent.status) {
    case 'succeeded': {
      if (payment.status === 'PENDING' || payment.status === 'AUTHORISED' || payment.status === 'FAILED') {
        payment.status = 'SUCCEEDED';
        payment.failureReason = undefined;
        await payment.save({ session });
      }
      if (booking.status === 'PAYMENT_PENDING' || booking.status === 'PENDING') {
        await confirmBooking(booking, payment, session, now);
      } else if (
        ['EXPIRED', 'CANCELLED', 'DECLINED'].includes(booking.status) &&
        payment.refunds.length === 0
      ) {
        // Paid after the dates were released (a very late payment): give it all back.
        await enqueue(
          'payment.refundUnwanted',
          { paymentId: payment.id },
          { uniqueKey: `refund-unwanted:${payment.id}`, session },
        );
      }
      return;
    }
    case 'requires_capture': {
      if (payment.status === 'PENDING' || payment.status === 'FAILED') {
        payment.status = 'AUTHORISED';
        payment.failureReason = undefined;
        await payment.save({ session });
      }
      if (booking.status === 'PAYMENT_PENDING') await markRequested(booking, session, now);
      return;
    }
    case 'canceled': {
      if (payment.status === 'PENDING' || payment.status === 'AUTHORISED') {
        payment.status = 'CANCELLED';
        await payment.save({ session });
      }
      return;
    }
    case 'requires_payment_method': {
      const reason = intent.last_payment_error?.message;
      if (reason && payment.status === 'PENDING') {
        payment.failureReason = reason.slice(0, 300);
        await payment.save({ session });
        if (booking.status === 'PAYMENT_PENDING') {
          await notifyPaymentFailed(
            booking.toObject() as BookingRecord,
            await loadBookingContext(booking.toObject() as BookingRecord),
            reason,
            { session },
          );
        }
      }
      return;
    }
    default:
      return;
  }
}

/** POST /bookings/{id}/payment/sync: after Stripe.js confirms, apply the result straight away. */
export async function syncBookingPayment(booking: BookingDocument): Promise<void> {
  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });
  if (!payment) return;
  const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
  await withTransaction((session) => applyPaymentIntent(intent, session));
}

/** Releases an authorisation, or stops an unfinished payment. An intent that's already final is left. */
export async function cancelIntent(payment: PaymentDocument | null): Promise<Stripe.PaymentIntent | null> {
  if (!payment) return null;
  const client = stripe();
  try {
    return await client.paymentIntents.cancel(
      payment.stripePaymentIntentId,
      {},
      { idempotencyKey: `cancel-${payment.stripePaymentIntentId}` },
    );
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      // Already cancelled or succeeded; report its state instead.
      return client.paymentIntents.retrieve(payment.stripePaymentIntentId);
    }
    throw error;
  }
}

/** Captures an authorised request once the Host accepts (plan §8.1, item 14). */
export async function captureIntent(payment: PaymentDocument): Promise<Stripe.PaymentIntent> {
  return stripe().paymentIntents.capture(
    payment.stripePaymentIntentId,
    {},
    { idempotencyKey: `capture-${payment.stripePaymentIntentId}` },
  );
}

export interface RefundRecord {
  amountCents: number;
  stripeRefundId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  failureReason?: string;
}

/** Refunds part or all of a payment. The key makes a retry return the same refund, never a second. */
export async function refundIntent(
  payment: PaymentDocument,
  amountCents: number,
  key: string,
): Promise<RefundRecord> {
  const alreadyRefunded = payment.refunds
    .filter((refund) => refund.status !== 'FAILED')
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  const amount = Math.min(amountCents, payment.amountCents - alreadyRefunded);
  if (amount <= 0) throw new HttpError(409, 'NOTHING_TO_REFUND', 'This payment has already been refunded.');
  try {
    const refund = await stripe().refunds.create(
      {
        payment_intent: payment.stripePaymentIntentId,
        amount,
        reason: 'requested_by_customer',
        metadata: { bookingId: payment.bookingId.toString() },
      },
      { idempotencyKey: key },
    );
    return {
      amountCents: amount,
      stripeRefundId: refund.id,
      status: refund.status === 'succeeded' ? 'SUCCEEDED' : refund.status === 'failed' ? 'FAILED' : 'PENDING',
      ...(refund.failure_reason && { failureReason: refund.failure_reason }),
    };
  } catch (error) {
    reportError(error, { tags: { area: 'refund' }, extra: { paymentId: payment.id } });
    throw error;
  }
}

/** A payment's status after its refunds. */
export function statusAfterRefunds(payment: PaymentDocument): PaymentDocument['status'] {
  const refunded = payment.refunds
    .filter((refund) => refund.status !== 'FAILED')
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  if (refunded <= 0) return payment.status;
  return refunded >= payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
}
