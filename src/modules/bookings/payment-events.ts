import type { ClientSession, Types } from 'mongoose';
import type Stripe from 'stripe';
import { logger } from '../../integrations/logger.js';
import { reportError } from '../../integrations/sentry.js';
import { formatNzdExact } from '../../lib/format.js';
import { applyExtraChargeIntent } from '../payments/extra-charges.service.js';
import { PaymentModel } from '../payments/payment.model.js';
import { holdBookingPayouts, hostRefundFailed, releaseHeldPayouts } from '../payouts/payouts.service.js';
import { alertStaff } from '../staff/staff-alerts.js';
import type { StripeEventHandler } from '../payments/stripe-webhook.js';
import { BookingModel } from './booking.model.js';
import { applyPaymentIntent, statusAfterRefunds } from './booking-payments.js';

/*
 * What each Stripe event does to bookings and payments (plan §8.1, items 4, 12, 13 and 21). Each
 * runs inside the transaction that records the event, writes only to the database, and is safe to
 * run twice.
 */

/** A booking's payment, or an extra charge's: each applies only to its own kind of payment. */
const intentEvent: StripeEventHandler = async (event, session) => {
  const intent = event.data.object as Stripe.PaymentIntent;
  await applyPaymentIntent(intent, session);
  await applyExtraChargeIntent(intent, session);
};

const intentId = (value: string | { id: string } | null | undefined) =>
  typeof value === 'string' ? value : value?.id;

/** A refund went through: the payment's pending refunds are complete once Stripe has refunded as much. */
async function chargeRefunded(event: Stripe.Event, session: ClientSession) {
  const charge = event.data.object as Stripe.Charge;
  const payment = await PaymentModel.findOne({
    stripePaymentIntentId: intentId(charge.payment_intent),
  }).session(session);
  if (!payment) return;
  let counted = 0;
  for (const refund of payment.refunds) {
    if (refund.status === 'FAILED') continue;
    counted += refund.amountCents;
    if (refund.status === 'PENDING' && counted <= charge.amount_refunded) refund.status = 'SUCCEEDED';
  }
  payment.status = statusAfterRefunds(payment);
  await payment.save({ session });
}

/**
 * A Host-funded refund that failed no longer comes off the Host's payouts (plan §8.1, items 15 and 21). What
 * was already taken from them is added to the staff alert, so staff can give it back.
 */
async function hostFundedRefundFailed(bookingId: Types.ObjectId, refundId: string, session: ClientSession) {
  const booking = await BookingModel.findById(bookingId).select('hostId').session(session).lean();
  if (!booking) return '';
  const { droppedCents, deductedCents, reversedCents } = await hostRefundFailed(
    booking.hostId,
    refundId,
    session,
  );
  const taken = [
    ...(deductedCents > 0 ? [`${formatNzdExact(deductedCents)} taken off a payout`] : []),
    ...(reversedCents > 0 ? [`${formatNzdExact(reversedCents)} taken back from a transfer`] : []),
  ];
  if (taken.length > 0) {
    return ` The Host funded it and had already paid for it (${taken.join(' and ')}): please return that to the Host.`;
  }
  return droppedCents > 0 ? ' The Host funded it: it no longer comes off their next payout.' : '';
}

/** A refund failed (e.g. a closed card): recorded, and support is alerted (plan §8.1, item 21). */
async function refundFailed(event: Stripe.Event, session: ClientSession) {
  const refund = event.data.object as Stripe.Refund;
  const payment = await PaymentModel.findOne({ 'refunds.stripeRefundId': refund.id }).session(session);
  if (!payment) return;
  const record = payment.refunds.find((candidate) => candidate.stripeRefundId === refund.id);
  if (!record || record.status === 'FAILED') return;
  record.status = 'FAILED';
  record.failureReason = refund.failure_reason ?? 'unknown';
  payment.status = statusAfterRefunds(payment);
  await payment.save({ session });
  const error = new Error(`Refund ${refund.id} failed: ${record.failureReason}`);
  logger.error({ paymentId: payment.id, refundId: refund.id }, error.message);
  reportError(error, { tags: { area: 'refund' }, extra: { paymentId: payment.id } });
  const hostNote =
    record.fundedBy === 'HOST' ? await hostFundedRefundFailed(payment.bookingId, refund.id, session) : '';
  await alertStaff(
    {
      type: 'REFUND_FAILED',
      title: 'A refund failed',
      body: `a refund of $${(record.amountCents / 100).toFixed(2)} failed (${record.failureReason}). Please return the money to the guest another way.${hostNote}`,
      link: `/admin/payments`,
      dedupeKey: `REFUND_FAILED:${refund.id}`,
    },
    { session },
  );
}

/** A card dispute (chargeback) is linked to its payment and holds the booking's payouts (plan §8.1, item 12). */
async function disputeChanged(event: Stripe.Event, session: ClientSession) {
  const dispute = event.data.object as Stripe.Dispute;
  const payment = await PaymentModel.findOne({
    stripePaymentIntentId: intentId(dispute.payment_intent),
  }).session(session);
  if (!payment) return;
  payment.dispute = {
    stripeDisputeId: dispute.id,
    reason: dispute.reason,
    status: dispute.status,
    ...(dispute.evidence_details?.due_by && { dueBy: new Date(dispute.evidence_details.due_by * 1000) }),
  };
  await payment.save({ session });
  if (event.type === 'charge.dispute.created') {
    const error = new Error(`Card dispute ${dispute.id} opened on payment ${payment.id}`);
    logger.error({ paymentId: payment.id, disputeId: dispute.id }, error.message);
    reportError(error, { tags: { area: 'dispute' }, extra: { paymentId: payment.id } });
    // Unpaid payouts for the booking wait until it's settled (plan §8.1, item 12).
    await holdBookingPayouts(payment.bookingId, 'DISPUTE', session);
    await alertStaff(
      {
        type: 'CARD_DISPUTE',
        title: 'A guest disputed a card payment',
        body: `a card dispute (${dispute.reason}) was opened on a booking payment. Answer it in Stripe with the inspection photos, messages and agreement acceptance${dispute.evidence_details?.due_by ? `, by ${new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10)}` : ''}.`,
        link: `/admin/payments`,
        dedupeKey: `CARD_DISPUTE:${dispute.id}`,
      },
      { session },
    );
  } else if (['won', 'lost', 'warning_closed'].includes(dispute.status)) {
    await releaseHeldPayouts({ bookingId: payment.bookingId }, 'DISPUTE', { session });
  }
}

export const bookingPaymentHandlers: Partial<Record<Stripe.Event['type'], StripeEventHandler>> = {
  'payment_intent.succeeded': intentEvent,
  'payment_intent.amount_capturable_updated': intentEvent,
  'payment_intent.payment_failed': intentEvent,
  'payment_intent.canceled': intentEvent,
  'charge.refunded': chargeRefunded,
  'refund.failed': refundFailed,
  'charge.dispute.created': disputeChanged,
  'charge.dispute.closed': disputeChanged,
};
