import type { ClientSession, Types } from 'mongoose';
import type Stripe from 'stripe';
import { logger } from '../../integrations/logger.js';
import { reportError } from '../../integrations/sentry.js';
import { enqueue } from '../../jobs/queue.js';
import { formatNzdExact } from '../../lib/format.js';
import { AuditLogModel } from '../audit/audit-log.model.js';
import { applyExtraChargeIntent } from '../payments/extra-charges.service.js';
import { CLOSED_DISPUTE_STATUSES, PaymentModel } from '../payments/payment.model.js';
import { holdBookingPayouts, hostRefundFailed, releaseHeldPayouts } from '../payouts/payouts.service.js';
import { raiseRiskFlag } from '../risk/risk-flags.js';
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

/** How long a refund Stripe reports gets to be recorded by whoever made it, before it's recorded from Stripe. */
const UNRECORDED_REFUND_GRACE_MS = 5 * 60_000;

/**
 * A refund went through: the payment's pending refunds are complete once Stripe has refunded as much. Stripe
 * refunding more than is recorded here means a refund we don't know about (one made in Stripe's dashboard, or
 * one whose record was lost when the transaction after it failed): `payment.syncRefunds` records it from
 * Stripe a few minutes on, once the code that made it has had time to record it itself.
 */
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
  if (charge.amount_refunded > counted) {
    await enqueue(
      'payment.syncRefunds',
      { paymentId: payment.id },
      {
        runAt: new Date(Date.now() + UNRECORDED_REFUND_GRACE_MS),
        uniqueKey: `sync-refunds:${payment.id}:${charge.amount_refunded}`,
        refId: payment.bookingId.toString(),
        session,
      },
    );
  }
}

/** Stripe's refund status as a payment records it. */
const refundStatus = (status: string | null): 'PENDING' | 'SUCCEEDED' | 'FAILED' =>
  status === 'succeeded' ? 'SUCCEEDED' : status === 'failed' || status === 'canceled' ? 'FAILED' : 'PENDING';

/**
 * Records the refunds Stripe has made on a payment that aren't recorded here, as funded by the platform, and
 * asks staff to check them (plan §8.1, items 13 and 15). Resolves how many it added.
 */
export async function recordStripeRefunds(
  paymentId: string,
  refunds: Pick<Stripe.Refund, 'id' | 'amount' | 'status' | 'created' | 'failure_reason'>[],
  session: ClientSession,
): Promise<number> {
  const payment = await PaymentModel.findById(paymentId).session(session);
  if (!payment) return 0;
  const missing = refunds.filter(
    (refund) =>
      refundStatus(refund.status) !== 'FAILED' &&
      !payment.refunds.some((known) => known.stripeRefundId === refund.id),
  );
  if (missing.length === 0) return 0;
  for (const refund of missing) {
    payment.refunds.push({
      amountCents: refund.amount,
      reason: 'Recorded from Stripe',
      kind: 'STAFF',
      fundedBy: 'PLATFORM',
      stripeRefundId: refund.id,
      status: refundStatus(refund.status),
      createdAt: new Date(refund.created * 1000),
    });
  }
  payment.status = statusAfterRefunds(payment);
  await payment.save({ session });
  const booking = await BookingModel.findById(payment.bookingId).select('ref').session(session).lean();
  const total = missing.reduce((sum, refund) => sum + refund.amount, 0);
  await alertStaff(
    {
      type: 'REFUND_UNRECORDED',
      title: `A refund on ${booking?.ref ?? 'a booking'} wasn’t recorded`,
      body: `Stripe refunded ${formatNzdExact(total)} of a payment on booking ${booking?.ref ?? payment.bookingId.toString()} that wasn’t recorded here. It's recorded now, as funded by Rento Vroom: check who should fund it, and that the guest was told.`,
      link: booking ? `/admin/bookings/${booking.ref}` : '/admin/payments',
      dedupeKey: `REFUND_UNRECORDED:${missing.map((refund) => refund.id).join(',')}`,
    },
    { session },
  );
  return missing.length;
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
  } else if ((CLOSED_DISPUTE_STATUSES as readonly string[]).includes(dispute.status)) {
    const booking = await BookingModel.findById(payment.bookingId).select('ref').session(session).lean();
    const ref = booking?.ref ?? payment.bookingId.toString();
    // Prevented: a dispute prevention programme refunded the cardholder, so the money went back as for a lost one.
    const prevented = dispute.status === 'prevented';
    if (dispute.status === 'lost' || prevented) {
      // The card issuer took the money back: the booking's unpaid payouts stay held until staff decide what the
      // Host gets (the owner's decision). The dispute's hold becomes a staff (MANUAL) hold, which only they release.
      await holdBookingPayouts(payment.bookingId, 'MANUAL', session);
      await AuditLogModel.create(
        [
          {
            action: 'payout.held',
            entity: 'booking',
            entityId: payment.bookingId.toString(),
            after: {
              holdReason: 'MANUAL',
              reason: prevented ? 'Card dispute prevented: refunded to the cardholder' : 'Card dispute lost',
              disputeId: dispute.id,
            },
          },
        ],
        { session },
      );
    } else {
      await releaseHeldPayouts({ bookingId: payment.bookingId }, 'DISPUTE', { session });
    }
    const outcome =
      dispute.status === 'lost'
        ? `was lost, so the ${formatNzdExact(dispute.amount)} went back to the guest’s card. The booking’s unpaid payouts stay on hold: decide what the Host gets, then release or cancel them`
        : prevented
          ? `was settled by a dispute prevention programme, which refunded the ${formatNzdExact(dispute.amount)} to the guest’s card. The booking’s unpaid payouts stay on hold: decide what the Host gets, then release or cancel them`
          : dispute.status === 'won'
            ? 'was won. The booking’s payouts held for it are released'
            : 'closed with a warning only, so nothing was taken back. The booking’s payouts held for it are released';
    await alertStaff(
      {
        type: 'CARD_DISPUTE_CLOSED',
        title: `Card dispute ${dispute.status === 'lost' ? 'lost' : prevented ? 'refunded' : dispute.status === 'won' ? 'won' : 'closed'} on ${ref}`,
        body: `the card dispute (${dispute.reason}) on booking ${ref} ${outcome}.`,
        link: `/admin/bookings/${ref}`,
        dedupeKey: `CARD_DISPUTE_CLOSED:${dispute.id}`,
      },
      { session },
    );
  }
}

/**
 * A Radar early fraud warning (plan §14, Stripe Radar warnings): the card issuer reported a payment as fraud,
 * which usually comes before a chargeback. The Guest gets a RADAR_WARNING flag (once while one waits for review)
 * and staff are alerted with the booking, as refunding the payment or cancelling the booking now heads the
 * chargeback off. A payment that isn't a booking's or an extra charge's (a staff test payment, say) is ignored.
 */
async function earlyFraudWarning(event: Stripe.Event, session: ClientSession) {
  const warning = event.data.object as Stripe.Radar.EarlyFraudWarning;
  const charge = typeof warning.charge === 'string' ? undefined : warning.charge;
  const intent = intentId(warning.payment_intent) ?? intentId(charge?.payment_intent);
  if (!intent) return;
  const payment = await PaymentModel.findOne({ stripePaymentIntentId: intent }).session(session);
  if (!payment) return;
  const booking = await BookingModel.findById(payment.bookingId)
    .select('ref guestId')
    .session(session)
    .lean();
  if (!booking) return;
  const fraud = (warning.fraud_type || 'fraud').replace(/_/g, ' ');
  const what = payment.type === 'EXTRA_CHARGE' ? 'an extra charge' : 'the booking’s payment';
  await raiseRiskFlag(
    booking.guestId,
    'RADAR_WARNING',
    `Stripe Radar: the card issuer reported ${what} on ${booking.ref} as fraud (${fraud})`,
    { now: new Date(event.created * 1000), session },
  );
  await alertStaff(
    {
      type: 'EARLY_FRAUD_WARNING',
      title: `Fraud reported on a payment for ${booking.ref}`,
      body: `the card issuer reported ${what} on booking ${booking.ref} (${formatNzdExact(payment.amountCents)}) as fraud: ${fraud}. ${
        warning.actionable
          ? 'A chargeback usually follows: refund the payment, or cancel the booking, before one is opened. The guest is flagged for review.'
          : 'Stripe says it’s already disputed or refunded, so there’s nothing to head off. The guest is flagged for review.'
      }`,
      link: `/admin/bookings/${booking.ref}`,
      dedupeKey: `EARLY_FRAUD_WARNING:${warning.id}`,
    },
    { session },
  );
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
  'radar.early_fraud_warning.created': earlyFraudWarning,
};
