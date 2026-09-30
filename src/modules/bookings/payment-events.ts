import type { ClientSession } from 'mongoose';
import type Stripe from 'stripe';
import { logger } from '../../integrations/logger.js';
import { reportError } from '../../integrations/sentry.js';
import { PaymentModel } from '../payments/payment.model.js';
import type { StripeEventHandler } from '../payments/stripe-webhook.js';
import { applyPaymentIntent, statusAfterRefunds } from './booking-payments.js';

/*
 * What each Stripe event does to bookings and payments (plan §8.1, items 4, 12, 13 and 21). Each
 * runs inside the transaction that records the event, writes only to the database, and is safe to
 * run twice.
 */

const intentEvent: StripeEventHandler = (event, session) =>
  applyPaymentIntent(event.data.object as Stripe.PaymentIntent, session);

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
}

/** A card dispute (chargeback) is linked to its payment (plan §8.1, item 12). Payout holds join in Phase 3. */
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
