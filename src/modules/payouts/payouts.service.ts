import mongoose, { type ClientSession, type Types } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { CHARGE_CURRENCY, stripe } from '../../integrations/stripe.js';
import { logger } from '../../integrations/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { formatNzDate, formatNzdExact } from '../../lib/format.js';
import { HttpError } from '../../lib/http-error.js';
import { nzDate } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { keptFeeCommission } from '../bookings/policies.js';
import { IncidentModel, OPEN_INCIDENT_STATUSES } from '../incidents/incident.model.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { notify } from '../notifications/notify.js';
import { PaymentModel, type Payment, type Refund } from '../payments/payment.model.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { UserModel, type RefundOwed } from '../users/user.model.js';
import {
  PayoutModel,
  type Deduction,
  type Payout,
  type PayoutDocument,
  type PayoutHoldReason,
} from './payout.model.js';

/*
 * Host payouts (plan §8.1, items 8–9, 15, 19–22; §4.3 `payout.transfer`). A confirmed booking schedules
 * its TRIP payout for 24 hours after the trip starts; a cancellation replaces it with the Host's share of
 * any kept fee. When it's due, the job checks the holds (payout setup, check-in, an open incident or card
 * dispute, a suspension), takes off Host cancellation fees and Host-funded refunds, and transfers the rest
 * to the Host's Stripe account. A held payout is checked again daily, and released at once when what held
 * it is fixed.
 */

type Id = Types.ObjectId;
type BookingRecord = Booking & { _id: Id };
type PayoutRecord = Payout & { _id: Id };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A trip's payout is sent this long after it starts (plan §8.1, item 9). */
export const PAYOUT_AFTER_START_HOURS = 24;
/** Stripe's usual time from a transfer to the Host's bank, when their account doesn't say. */
const DEFAULT_BANK_DAYS = 4;

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
/** GST included in an amount (15 %, plan §5): 3/23 of it. */
export const gstIn = (cents: number, ratePct: number) => Math.round((cents * ratePct) / (100 + ratePct));

/**
 * What the Host pays back for a refund they fund (plan §8.1, item 15): their share of it, as worked out when
 * it was made. A refund recorded before shares were kept has none: the Host paid all of it.
 */
export const hostPartOf = (refund: Pick<Refund, 'amountCents' | 'hostCents'>) =>
  refund.hostCents ?? refund.amountCents;

/** What a Host-funded refund of one payment can cover, and the Host's payout it comes out of. */
export interface HostRefundTerms {
  /** The most a Host-funded refund of the payment can be now. */
  maxCents: number;
  /** What the Host's payout was worked out from: the rental and delivery, the kept rental or the extra charge. */
  baseCents: number;
  /** The Host's payout from it, before deductions. */
  payoutCents: number;
  /** The Host's share not refunded yet. */
  hostLeftCents: number;
}

/**
 * A Host-funded refund is "a policy refund of rental the Host would otherwise receive" (plan §8.1, item 15),
 * so it can cover only what the Host's payout came from: the booking's rental and delivery (on a cancelled
 * booking, the kept rental the Host has a share of), or an extra charge. Not the service fee or protection.
 */
export async function hostRefundTerms(
  booking: Pick<
    BookingRecord,
    '_id' | 'status' | 'price' | 'startAt' | 'cancellationTerms' | 'hostShareCents'
  >,
  payment: Pick<Payment, 'type' | 'extraChargeId' | 'amountCents' | 'refunds'>,
  session?: ClientSession,
): Promise<HostRefundTerms> {
  let baseCents = 0;
  let payoutCents = 0;
  if (payment.type === 'EXTRA_CHARGE') {
    // The charge's own payout, with the commission it was made with (plan §8.1, item 11).
    const payout = await PayoutModel.findOne({
      bookingId: booking._id,
      type: 'EXTRA_CHARGE',
      extraChargeId: payment.extraChargeId,
      status: mongoose.trusted({ $ne: 'CANCELLED' }),
    })
      .select('commissionCents')
      .session(session ?? null)
      .lean();
    const commission =
      payout?.commissionCents ??
      Math.round((payment.amountCents * (await getPlatformSettings()).fees.hostCommissionPct) / 100);
    baseCents = payment.amountCents;
    payoutCents = payment.amountCents - commission;
  } else if (booking.status === 'CANCELLED') {
    payoutCents = booking.hostShareCents ?? 0;
    baseCents = payoutCents + keptFeeCommission(booking);
  } else if (booking.status !== 'DECLINED' && booking.status !== 'EXPIRED') {
    baseCents = booking.price.subtotalCents + booking.price.deliveryCents;
    payoutCents = booking.price.hostPayoutCents;
  }
  const live = payment.refunds.filter((refund) => refund.status !== 'FAILED');
  // A cancellation's own refund was settled by the policy (the kept fee), not out of the Host's payout.
  const hostFunded = live.filter((refund) => refund.fundedBy === 'HOST' && refund.kind !== 'CANCELLATION');
  const sum = (refunds: typeof live, part: (refund: Refund) => number) =>
    refunds.reduce((total, refund) => total + part(refund), 0);
  const refundable = payment.amountCents - sum(live, (refund) => refund.amountCents);
  return {
    maxCents: Math.max(0, Math.min(baseCents - sum(hostFunded, (refund) => refund.amountCents), refundable)),
    baseCents,
    payoutCents,
    hostLeftCents: Math.max(0, payoutCents - sum(hostFunded, hostPartOf)),
  };
}

/**
 * The Host's share of a refund they fund (plan §8.1, item 15): the part of it their payout came from, so the
 * platform covers its commission, and never more than their share not refunded yet.
 */
export function hostShareOfRefund(terms: HostRefundTerms, amountCents: number): number {
  if (terms.baseCents <= 0) return 0;
  const share = Math.round((amountCents * terms.payoutCents) / terms.baseCents);
  return Math.max(0, Math.min(terms.hostLeftCents, share));
}

export async function queueTransfer(
  payout: Pick<PayoutRecord, '_id' | 'bookingId'>,
  runAt: Date,
  session?: ClientSession,
) {
  const id = payout._id.toString();
  await enqueue(
    'payout.transfer',
    { payoutId: id },
    { runAt, uniqueKey: `payout:${id}:${runAt.getTime()}`, refId: payout.bookingId.toString(), session },
  );
}

/**
 * A confirmed booking's TRIP payout: the rental and delivery less commission, 24 h after the trip starts.
 * Safe to call twice: the unique index keeps one per booking.
 */
export async function scheduleTripPayout(booking: BookingRecord, session: ClientSession, now = new Date()) {
  const settings = await getPlatformSettings();
  const gross = booking.price.subtotalCents + booking.price.deliveryCents;
  const commission = gross - booking.price.hostPayoutCents;
  const scheduledFor = new Date(
    Math.max(booking.startAt.getTime() + PAYOUT_AFTER_START_HOURS * HOUR_MS, now.getTime()),
  );
  const existing = await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' }).session(session);
  if (existing) return existing;
  const [payout] = await PayoutModel.create(
    [
      {
        hostId: booking.hostId,
        bookingId: booking._id,
        type: 'TRIP',
        amountCents: booking.price.hostPayoutCents,
        grossCents: gross,
        commissionCents: commission,
        commissionGstCents: gstIn(commission, settings.fees.gstRatePct),
        status: 'SCHEDULED',
        scheduledFor,
      },
    ],
    { session },
  );
  await queueTransfer(payout!, scheduledFor, session);
  return payout!;
}

/** What a paid payout was worth to the Host before its deductions (those settled what they owed elsewhere). */
const paidGross = (payout: Pick<PayoutRecord, 'amountCents' | 'deductions'>) =>
  payout.amountCents + (payout.deductions ?? []).reduce((sum, deduction) => sum + deduction.amountCents, 0);

/** The key a paid trip payout's overpayment is owed under, as its own line on the Host's next payout. */
const overpaidKey = (payoutId: Id | string) => `trip-payout-${payoutId.toString()}`;
/** Whether what the Host owes (or a deduction for it) is a payout already sent, not a refund (plan §8.1, item 15). */
export const isPayoutSentBack = (key: string | undefined) => Boolean(key?.startsWith('trip-payout-'));

/**
 * Where a booking's TRIP payout stands as the booking is cancelled (plan §8.1, items 15 and 16). NONE: there
 * is none (or it's cancelled); UNPAID: it's cancelled and replaced by the Host's share of any kept fee;
 * IN_FLIGHT: its deductions are reserved and its transfer is being made, so the cancellation waits a minute;
 * PAID: it went before the cancellation (a Guest no-show after the Host's check-in), so the Host keeps only their
 * share of the kept fee and owes the rest off their next payout (owedCents), or is paid the difference
 * (topUpCents). `reliefCents`: what the cancellation took off the Host's share of the booking's earlier
 * Host-funded refunds, which the Host paid in full so far, so it's theirs back. A transfer that failed without a
 * clear answer may have gone through all the same: outside a transaction, Stripe is asked, and a transfer it
 * made is recorded as paid.
 */
export async function tripPayoutOnCancel(
  bookingId: Id,
  hostShareCents: number,
  {
    session,
    reliefCents = 0,
    now = new Date(),
  }: { session?: ClientSession; reliefCents?: number; now?: Date } = {},
): Promise<
  | { state: 'NONE' | 'UNPAID' | 'IN_FLIGHT' }
  | { state: 'PAID'; paidCents: number; owedCents: number; topUpCents: number }
> {
  let trip = await PayoutModel.findOne({ bookingId, type: 'TRIP' })
    .session(session ?? null)
    .lean<PayoutRecord>();
  if (!trip || trip.status === 'CANCELLED') return { state: 'NONE' };
  if (trip.status === 'SCHEDULED' && trip.deductionsReservedAt) return { state: 'IN_FLIGHT' };
  if (trip.status === 'FAILED' && trip.deductionsReservedAt && !session) {
    const found = await paidIfTransferred(trip, now).catch(() => null);
    // Stripe couldn't be asked: whether it was sent isn't known yet, so the cancellation waits.
    if (!found) return { state: 'IN_FLIGHT' };
    trip = found;
    if (trip.status === 'SCHEDULED' && trip.deductionsReservedAt) return { state: 'IN_FLIGHT' };
  }
  if (trip.status === 'CANCELLED') return { state: 'NONE' };
  if (trip.status !== 'PAID') return { state: 'UNPAID' };
  const paidCents = paidGross(trip);
  return {
    state: 'PAID',
    paidCents,
    owedCents: Math.max(0, paidCents - hostShareCents - reliefCents),
    topUpCents: Math.max(0, hostShareCents + reliefCents - paidCents),
  };
}

/**
 * A FAILED payout whose transfer Stripe made after all (a timeout or a 5xx it finished): recorded as paid, with
 * the deductions reserved for it, as the transfer sent the payout less those. Resolves the payout as it is now.
 */
async function paidIfTransferred(payout: PayoutRecord, now: Date): Promise<PayoutRecord> {
  const booking = await BookingModel.findById(payout.bookingId).select('ref').lean();
  const transferId = booking && (await existingTransfer(payout._id.toString(), booking.ref));
  if (!transferId) return payout;
  await PayoutModel.updateOne(
    { _id: payout._id, status: 'FAILED' },
    {
      $set: {
        status: 'PAID',
        paidAt: now,
        amountCents: Math.max(0, payout.amountCents - reservedCents(payout)),
        stripeTransferId: transferId,
      },
      $unset: { holdReason: 1, failureReason: 1 },
    },
  );
  return (await PayoutModel.findById(payout._id).lean<PayoutRecord>()) ?? payout;
}

/**
 * What a cancellation took off the Host's share of the booking's earlier Host-funded refunds (plan §8.1, item
 * 15): the Guest got that part back under the cancellation anyway.
 */
async function refundReliefCents(bookingId: Id, session: ClientSession): Promise<number> {
  const payments = await PaymentModel.find({ bookingId, type: 'BOOKING' })
    .select('refunds')
    .session(session)
    .lean();
  return payments
    .flatMap((payment) => payment.refunds)
    .filter((refund) => refund.fundedBy === 'HOST' && refund.status !== 'FAILED')
    .reduce((sum, refund) => sum + (refund.hostReliefCents ?? 0), 0);
}

/**
 * A booking ended: an unpaid TRIP payout is cancelled, and the Host's share of a kept Guest cancellation
 * fee (no-shows included) becomes a CANCELLATION_FEE payout, paid when the trip's would have been
 * (plan §4.2, §8.1 item 16). A TRIP payout already paid (a Guest no-show after the Host's check-in) isn't paid
 * again: the Host keeps their share of the kept fee from it, and owes the rest off their next payout, shown as
 * a line on it, or is paid the difference when their share is the bigger (plan §8.1, item 15). A failed one is
 * cancelled too, and what it reserved given back.
 */
export async function replaceTripPayout(booking: BookingRecord, session: ClientSession, now = new Date()) {
  const cancelled = await PayoutModel.findOneAndUpdate(
    {
      bookingId: booking._id,
      type: 'TRIP',
      status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }),
    },
    { $set: { status: 'CANCELLED', deductions: [] }, $unset: { holdReason: 1, deductionsReservedAt: 1 } },
    { new: false, session },
  ).lean<PayoutRecord>();
  if (cancelled) {
    await giveBackDeductions(cancelled, session);
    await oweOwnRefunds(cancelled, session, now);
  }
  let share = booking.hostShareCents ?? 0;
  const settled = cancelled
    ? null
    : await tripPayoutOnCancel(booking._id, share, {
        session,
        reliefCents: await refundReliefCents(booking._id, session),
      });
  if (settled?.state === 'PAID') {
    const trip = await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' })
      .select('_id')
      .session(session)
      .lean();
    if (settled.owedCents > 0) {
      await addRefundOwed(booking.hostId, booking._id, overpaidKey(trip!._id), settled.owedCents, session);
    }
    share = settled.topUpCents;
  }
  if (share <= 0) return;
  if (await PayoutModel.exists({ bookingId: booking._id, type: 'CANCELLATION_FEE' }).session(session)) return;
  const settings = await getPlatformSettings();
  const scheduledFor = new Date(
    Math.max(booking.startAt.getTime() + PAYOUT_AFTER_START_HOURS * HOUR_MS, now.getTime()),
  );
  // A top-up after a paid trip payout carries its part of the commission (none on refund relief beyond the share).
  const commission = Math.round(
    (keptFeeCommission(booking) * Math.min(share, booking.hostShareCents ?? share)) /
      Math.max(1, booking.hostShareCents ?? share),
  );
  const [payout] = await PayoutModel.create(
    [
      {
        hostId: booking.hostId,
        bookingId: booking._id,
        type: 'CANCELLATION_FEE',
        amountCents: share,
        grossCents: share + commission,
        commissionCents: commission,
        commissionGstCents: gstIn(commission, settings.fees.gstRatePct),
        status: 'SCHEDULED',
        scheduledFor,
      },
    ],
    { session },
  );
  await queueTransfer(payout!, scheduledFor, session);
}

/** The Host's share of a paid extra charge, as its own payout, sent now under the usual holds (plan §8.1, item 11). */
export async function scheduleExtraChargePayout(
  booking: BookingRecord,
  charge: { _id: Id; amountCents: number },
  session: ClientSession,
  now = new Date(),
) {
  const settings = await getPlatformSettings();
  const commission = Math.round((charge.amountCents * settings.fees.hostCommissionPct) / 100);
  const existing = await PayoutModel.findOne({
    bookingId: booking._id,
    type: 'EXTRA_CHARGE',
    extraChargeId: charge._id,
  }).session(session);
  if (existing) return existing;
  const [payout] = await PayoutModel.create(
    [
      {
        hostId: booking.hostId,
        bookingId: booking._id,
        type: 'EXTRA_CHARGE',
        extraChargeId: charge._id,
        amountCents: charge.amountCents - commission,
        grossCents: charge.amountCents,
        commissionCents: commission,
        commissionGstCents: gstIn(commission, settings.fees.gstRatePct),
        status: 'SCHEDULED',
        scheduledFor: now,
      },
    ],
    { session },
  );
  await queueTransfer(payout!, now, session);
  return payout!;
}

/** What holds a payout now, if anything (plan §8.1, item 9; §8.2). */
async function holdFor(payout: PayoutDocument, booking: BookingRecord): Promise<PayoutHoldReason | null> {
  const host = await UserModel.findById(payout.hostId).select('status hostProfile').lean();
  if (!host || host.status === 'SUSPENDED' || host.hostProfile?.status === 'SUSPENDED') return 'SUSPENDED';
  if (!host.hostProfile?.stripeAccountId || !host.hostProfile.payoutsEnabled) return 'PAYOUT_SETUP';
  if (
    await IncidentModel.exists({
      bookingId: booking._id,
      status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }),
    })
  ) {
    return 'INCIDENT';
  }
  const disputed = await PaymentModel.exists({
    bookingId: booking._id,
    'dispute.status': mongoose.trusted({ $exists: true, $nin: ['won', 'lost', 'warning_closed'] }),
  });
  if (disputed) return 'DISPUTE';
  // A trip's payout waits for check-in, or support marking the trip as started: the trip went ahead (a kept
  // fee needs none).
  if (
    payout.type === 'TRIP' &&
    !['ACTIVE', 'COMPLETED'].includes(booking.status) &&
    !(await ConditionReportModel.exists({ bookingId: booking._id, stage: 'CHECK_IN' }))
  ) {
    return 'TRIP_NOT_STARTED';
  }
  return null;
}

/** The charge the payout's money came from, so the transfer can be made before the funds are available. */
async function sourceCharge(payout: PayoutDocument): Promise<string | undefined> {
  const payment = await PaymentModel.findOne(
    payout.type === 'EXTRA_CHARGE'
      ? {
          bookingId: payout.bookingId,
          type: 'EXTRA_CHARGE',
          extraChargeId: payout.extraChargeId,
          // A charge partly refunded still funds the rest of its payout.
          status: mongoose.trusted({ $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] }),
        }
      : {
          bookingId: payout.bookingId,
          type: 'BOOKING',
          status: mongoose.trusted({ $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] }),
        },
  )
    .sort({ createdAt: -1 })
    .lean();
  if (!payment) return undefined;
  try {
    const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
    const charge = intent.latest_charge;
    return typeof charge === 'string' ? charge : charge?.id;
  } catch (error) {
    logger.warn({ err: error, payoutId: payout.id }, 'Could not find the charge behind a payout');
    return undefined;
  }
}

/** A transfer Stripe already made for this payout (each carries its payout's id), not reversed since. */
async function existingTransfer(payoutId: string, bookingRef: string): Promise<string | undefined> {
  const { data } = await stripe().transfers.list({ transfer_group: bookingRef, limit: 100 });
  return data.find((transfer) => transfer.metadata?.payoutId === payoutId && !transfer.reversed)?.id;
}

/**
 * What comes off a payout (plan §8.1, items 10 and 15): a TRIP payout first takes the Host-funded refunds
 * made on its own booking before it was sent, a line each; then any payout takes the Host cancellation fees
 * owed and the Host-funded refunds owed from bookings already paid, oldest first. Never below zero:
 * anything left stays owed, including the part of a refund on this booking the payout can't cover
 * (`carryOver`, added to what the Host owes).
 */
async function deductionsFor(
  payout: PayoutRecord,
  booking: BookingRecord,
  session: ClientSession,
  now: Date,
): Promise<{ deductions: Deduction[]; carryOver: RefundOwed[] }> {
  const deductions: Deduction[] = [];
  const carryOver: RefundOwed[] = [];
  let left = payout.amountCents;
  const take = (deduction: Omit<Deduction, 'amountCents'>, owedCents: number) => {
    const amount = Math.min(left, owedCents);
    if (amount <= 0) return;
    deductions.push({ ...deduction, amountCents: amount });
    left -= amount;
  };
  if (payout.type === 'TRIP' || payout.type === 'EXTRA_CHARGE') {
    // A trip's payout takes the refunds of the booking's payment; an extra charge's, those of that charge.
    const payments = await PaymentModel.find(
      payout.type === 'TRIP'
        ? { bookingId: booking._id, type: 'BOOKING' }
        : { bookingId: booking._id, type: 'EXTRA_CHARGE', extraChargeId: payout.extraChargeId },
    )
      .session(session)
      .lean();
    for (const refund of payments.flatMap((payment) => payment.refunds)) {
      if (refund.fundedBy !== 'HOST' || refund.status === 'FAILED') continue;
      // The Host's share of it: the platform covers its commission.
      const owed = hostPartOf(refund);
      const before = left;
      take(
        {
          type: 'HOST_FUNDED_REFUND',
          bookingId: booking._id,
          ...(refund.stripeRefundId && { stripeRefundId: refund.stripeRefundId }),
        },
        owed,
      );
      const uncovered = owed - (before - left);
      if (uncovered > 0 && refund.stripeRefundId) {
        carryOver.push({
          bookingId: booking._id,
          stripeRefundId: refund.stripeRefundId,
          amountCents: uncovered,
          createdAt: now,
        });
      }
    }
  }
  const host = await UserModel.findById(payout.hostId)
    .select('hostProfile.feesOwedCents hostProfile.refundsOwed')
    .session(session)
    .lean();
  take({ type: 'HOST_CANCELLATION_FEE', owed: true }, host?.hostProfile?.feesOwedCents ?? 0);
  for (const refund of host?.hostProfile?.refundsOwed ?? []) {
    take(
      {
        type: 'HOST_FUNDED_REFUND',
        bookingId: refund.bookingId,
        stripeRefundId: refund.stripeRefundId,
        owed: true,
      },
      refund.amountCents,
    );
  }
  return { deductions, carryOver };
}

/** Thrown when what the Host owes changed under a reservation: it's worked out again. */
class OwedChanged extends Error {}

/** Tries at reserving a payout's deductions while the Host's other payouts take from the same balance. */
const RESERVE_TRIES = 5;

/** Takes the deductions that came from what the Host owes off their balance, each only if it's still owed. */
async function takeOwed(hostId: Id, deductions: Deduction[], session: ClientSession) {
  let refunds = false;
  for (const deduction of deductions) {
    if (!deduction.owed) continue;
    const taken =
      deduction.type === 'HOST_CANCELLATION_FEE'
        ? await UserModel.updateOne(
            { _id: hostId, 'hostProfile.feesOwedCents': mongoose.trusted({ $gte: deduction.amountCents }) },
            { $inc: { 'hostProfile.feesOwedCents': -deduction.amountCents } },
            { session },
          )
        : await UserModel.updateOne(
            {
              _id: hostId,
              'hostProfile.refundsOwed': mongoose.trusted({
                $elemMatch: {
                  stripeRefundId: deduction.stripeRefundId,
                  amountCents: { $gte: deduction.amountCents },
                },
              }),
            },
            { $inc: { 'hostProfile.refundsOwed.$.amountCents': -deduction.amountCents } },
            { session },
          );
    if (taken.modifiedCount === 0) throw new OwedChanged();
    refunds ||= deduction.type === 'HOST_FUNDED_REFUND';
  }
  // A refund now taken in full leaves the list.
  if (refunds) {
    await UserModel.updateOne(
      { _id: hostId },
      { $pull: { 'hostProfile.refundsOwed': { amountCents: 0 } } },
      { session },
    );
  }
}

/**
 * Takes what the Host owes off this payout before anything is sent (plan §8.1, items 10 and 15). The
 * deductions are worked out and taken from the Host's balance in one transaction, each only if it's still
 * owed, so two of the Host's payouts sent at once can't both take the same fee; if the balance changed
 * meanwhile, they're worked out again. A payout keeps its reservation, so a retry after an unclear Stripe
 * failure sends the same amount. Null: the payout was paid or cancelled meanwhile.
 */
async function reserveDeductions(
  payout: PayoutDocument,
  booking: BookingRecord,
  now: Date,
): Promise<Deduction[] | null> {
  if (payout.deductionsReservedAt) return (payout.toObject() as PayoutRecord).deductions;
  for (let tries = 0; tries < RESERVE_TRIES; tries += 1) {
    try {
      return await withTransaction(async (session) => {
        const fresh = await PayoutModel.findById(payout._id).session(session).lean<PayoutRecord>();
        if (!fresh || fresh.status === 'PAID' || fresh.status === 'CANCELLED') return null;
        // Staff held it a moment ago: it waits for them.
        if (fresh.holdReason === 'MANUAL') return null;
        if (fresh.deductionsReservedAt) return fresh.deductions;
        const { deductions, carryOver } = await deductionsFor(fresh, booking, session, now);
        await takeOwed(fresh.hostId, deductions, session);
        if (carryOver.length > 0) {
          await UserModel.updateOne(
            { _id: fresh.hostId },
            { $push: { 'hostProfile.refundsOwed': { $each: carryOver } } },
            { session },
          );
        }
        const reserved = await PayoutModel.updateOne(
          {
            _id: fresh._id,
            status: mongoose.trusted({ $nin: ['PAID', 'CANCELLED'] }),
            holdReason: mongoose.trusted({ $ne: 'MANUAL' }),
            deductionsReservedAt: mongoose.trusted({ $exists: false }),
          },
          { $set: { deductions, deductionsReservedAt: now } },
          { session },
        );
        if (reserved.modifiedCount === 0) throw new OwedChanged();
        return deductions;
      });
    } catch (error) {
      if (!(error instanceof OwedChanged)) throw error;
    }
  }
  throw new Error(`The deductions for payout ${payout.id} kept changing`);
}

/**
 * A payout cancelled before it was paid gives back what its reservation took: the fees and refunds are owed
 * again and come off a later payout, except a refund that has failed since (plan §8.1, items 15 and 21).
 * Pass the payout as it was before it was cancelled.
 */
async function giveBackDeductions(payout: PayoutRecord, session: ClientSession) {
  if (!payout.deductionsReservedAt) return;
  for (const deduction of payout.deductions) {
    if (!deduction.owed) continue;
    if (deduction.type === 'HOST_CANCELLATION_FEE') {
      await UserModel.updateOne(
        { _id: payout.hostId },
        { $inc: { 'hostProfile.feesOwedCents': deduction.amountCents } },
        { session },
      );
      continue;
    }
    if (deduction.type !== 'HOST_FUNDED_REFUND' || !deduction.stripeRefundId || !deduction.bookingId)
      continue;
    const failed = await PaymentModel.exists({
      refunds: mongoose.trusted({
        $elemMatch: { stripeRefundId: deduction.stripeRefundId, status: 'FAILED' },
      }),
    }).session(session);
    if (failed) continue;
    await addRefundOwed(
      payout.hostId,
      deduction.bookingId,
      deduction.stripeRefundId,
      deduction.amountCents,
      session,
    );
  }
}

/** Adds to what the Host owes for a refund, on its own line (plan §8.1, item 15). */
async function addRefundOwed(
  hostId: Id,
  bookingId: Id,
  stripeRefundId: string,
  amountCents: number,
  session: ClientSession,
) {
  const back = await UserModel.updateOne(
    { _id: hostId, 'hostProfile.refundsOwed.stripeRefundId': stripeRefundId },
    { $inc: { 'hostProfile.refundsOwed.$.amountCents': amountCents } },
    { session },
  );
  if (back.matchedCount > 0) return;
  await UserModel.updateOne(
    { _id: hostId },
    {
      $push: {
        'hostProfile.refundsOwed': { bookingId, stripeRefundId, amountCents, createdAt: new Date() },
      },
    },
    { session },
  );
}

/** Takes up to `cents` off what the Host owes for a refund, e.g. once a cancellation lowered their share of it. */
async function reduceRefundOwed(hostId: Id, stripeRefundId: string, cents: number, session: ClientSession) {
  const host = await UserModel.findById(hostId).select('hostProfile.refundsOwed').session(session).lean();
  const owed = host?.hostProfile?.refundsOwed?.find((line) => line.stripeRefundId === stripeRefundId);
  const less = Math.min(cents, owed?.amountCents ?? 0);
  if (less <= 0) return;
  await UserModel.updateOne(
    { _id: hostId, 'hostProfile.refundsOwed.stripeRefundId': stripeRefundId },
    { $inc: { 'hostProfile.refundsOwed.$.amountCents': -less } },
    { session },
  );
  await UserModel.updateOne(
    { _id: hostId },
    { $pull: { 'hostProfile.refundsOwed': { amountCents: 0 } } },
    { session },
  );
}

/**
 * A trip's payout cancelled before it was sent: the Host-funded refunds on the booking that were to come off
 * it are owed instead, and come off the Host's next payout (plan §8.1, item 15). Unreserved, it was to take the
 * Host's share of each (as the cancellation left it); reserved, what its deductions took (any rest is owed
 * already), less what the cancellation took off the Host's share since. Once only for a payout. Pass the payout
 * as it was before it was cancelled.
 */
async function oweOwnRefunds(payout: PayoutRecord, session: ClientSession, now = new Date()) {
  if (payout.type !== 'TRIP') return;
  const first = await PayoutModel.updateOne(
    { _id: payout._id, ownRefundsOwedAt: mongoose.trusted({ $exists: false }) },
    { $set: { ownRefundsOwedAt: now } },
    { session },
  );
  if (first.modifiedCount === 0) return;
  const payments = await PaymentModel.find({ bookingId: payout.bookingId, type: 'BOOKING' })
    .session(session)
    .lean();
  for (const refund of payments.flatMap((payment) => payment.refunds)) {
    if (refund.fundedBy !== 'HOST' || refund.status === 'FAILED' || refund.kind === 'CANCELLATION') continue;
    if (!refund.stripeRefundId) continue;
    let owed = hostPartOf(refund);
    if (payout.deductionsReservedAt) {
      const taken = payout.deductions
        .filter(
          (deduction) =>
            !deduction.owed &&
            deduction.type === 'HOST_FUNDED_REFUND' &&
            deduction.stripeRefundId === refund.stripeRefundId,
        )
        .reduce((sum, deduction) => sum + deduction.amountCents, 0);
      // The reservation took the Host's whole share as it was then: the cancellation's relief comes off what it
      // took, then off any rest the Host already owes for it.
      const relief = refund.hostReliefCents ?? 0;
      owed = Math.max(0, taken - relief);
      if (relief > taken) {
        await reduceRefundOwed(payout.hostId, refund.stripeRefundId, relief - taken, session);
      }
    }
    if (owed > 0) await addRefundOwed(payout.hostId, payout.bookingId, refund.stripeRefundId, owed, session);
  }
}

/**
 * A trip's payout cancelled (its booking was cancelled) while its transfer was being made, or after one that
 * failed without a clear answer went through: the transfer went out all the same, so it's recorded as paid,
 * without the deductions its cancellation gave back, and what it sent comes off the Host's next payout, so
 * they're never paid twice (plan §8.1, items 15 and 16). False when it was paid already.
 */
async function sentAfterCancel(
  payout: PayoutRecord,
  booking: BookingRecord,
  { amount, transferId }: { amount: number; transferId?: string },
  session: ClientSession,
  now: Date,
): Promise<boolean> {
  const updated = await PayoutModel.updateOne(
    { _id: payout._id, status: mongoose.trusted({ $ne: 'PAID' }) },
    {
      $set: {
        status: 'PAID',
        paidAt: now,
        amountCents: amount,
        deductions: [],
        ...(transferId && { stripeTransferId: transferId }),
      },
      $unset: { holdReason: 1, failureReason: 1 },
    },
    { session },
  );
  if (updated.matchedCount === 0) return false;
  if (amount > 0) await addRefundOwed(payout.hostId, booking._id, overpaidKey(payout._id), amount, session);
  const host = await UserModel.findById(payout.hostId).select('firstName').session(session).lean();
  await alertStaff(
    {
      type: 'PAYOUT_SENT_AFTER_CANCEL',
      title: `A cancelled payout for ${booking.ref} was sent`,
      body: `the ${formatNzdExact(amount)} payout for booking ${booking.ref} was being transferred to ${host?.firstName ?? 'the host'} as it was cancelled, and the transfer went through. It now comes off their next payout. Check it if they contact us.`,
      link: `/admin/bookings/${booking.ref}`,
      dedupeKey: `PAYOUT_SENT_AFTER_CANCEL:${payout._id.toString()}`,
    },
    { session },
  );
  return true;
}

export type PayoutOutcome = 'paid' | 'held' | 'skipped' | 'failed';

/**
 * `payout.transfer`: sends one payout, or holds it with the reason and checks again tomorrow. A transfer
 * that Stripe refuses is marked FAILED and support is alerted; the job's retries try it again.
 */
export async function runPayout(payoutId: string, now = new Date()): Promise<PayoutOutcome> {
  const payout = await PayoutModel.findById(payoutId);
  if (!payout || payout.status === 'PAID' || payout.status === 'CANCELLED') return 'skipped';
  if (payout.scheduledFor > now) return 'skipped';
  // Held by staff: it waits until they release it.
  if (payout.status === 'HELD' && payout.holdReason === 'MANUAL') return 'held';
  const booking = await BookingModel.findById(payout.bookingId).lean<BookingRecord>();
  if (!booking) return 'skipped';
  if (payout.type === 'TRIP' && ['CANCELLED', 'DECLINED', 'EXPIRED'].includes(booking.status)) {
    // A transfer that failed without a clear answer may have gone through all the same.
    const transferId =
      payout.status === 'FAILED' && payout.deductionsReservedAt
        ? await existingTransfer(payout.id, booking.ref)
        : undefined;
    const sent = await withTransaction(async (session) => {
      const cancelled = await PayoutModel.findOneAndUpdate(
        { _id: payout._id, status: mongoose.trusted({ $nin: ['PAID', 'CANCELLED'] }) },
        { $set: { status: 'CANCELLED', deductions: [] }, $unset: { deductionsReservedAt: 1 } },
        { new: false, session },
      ).lean<PayoutRecord>();
      if (!cancelled) return false;
      await giveBackDeductions(cancelled, session);
      await oweOwnRefunds(cancelled, session, now);
      if (!transferId) return false;
      // It went: recorded as sent after the cancellation, so what it sent is owed back.
      const amount = Math.max(0, cancelled.amountCents - reservedCents(cancelled));
      return sentAfterCancel(cancelled, booking, { amount, transferId }, session, now);
    });
    return sent ? 'paid' : 'skipped';
  }

  const hold = await holdFor(payout, booking);
  if (hold) {
    // Never a payout cancelled or paid meanwhile, nor one staff held: only they release that.
    const held = await PayoutModel.updateOne(
      {
        _id: payout._id,
        status: mongoose.trusted({ $nin: ['PAID', 'CANCELLED'] }),
        holdReason: mongoose.trusted({ $ne: 'MANUAL' }),
      },
      { $set: { status: 'HELD', holdReason: hold } },
    );
    if (held.matchedCount === 0) return 'skipped';
    // Checked again each day, and straight away when what holds it is fixed.
    await enqueue(
      'payout.transfer',
      { payoutId },
      {
        runAt: new Date(now.getTime() + DAY_MS),
        uniqueKey: `payout:${payoutId}:${nzDate(new Date(now.getTime() + DAY_MS))}`,
        refId: booking._id.toString(),
      },
    );
    if (hold === 'PAYOUT_SETUP') await remindPayoutSetup(payout, booking, now);
    return 'held';
  }

  const deductions = await reserveDeductions(payout, booking, now);
  if (!deductions) return 'skipped';
  // Being sent from here (a retry of a failed transfer, or a held payout released, too): SCHEDULED with its
  // deductions reserved, so a cancellation waits for it and staff can't hold it meanwhile.
  const sending = await PayoutModel.updateOne(
    {
      _id: payout._id,
      status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }),
      holdReason: mongoose.trusted({ $ne: 'MANUAL' }),
    },
    { $set: { status: 'SCHEDULED' }, $unset: { holdReason: 1 } },
  );
  if (sending.matchedCount === 0) return 'skipped';
  const deducted = deductions.reduce((sum, deduction) => sum + deduction.amountCents, 0);
  const amount = payout.amountCents - deducted;
  const host = await UserModel.findById(payout.hostId).select('firstName hostProfile').lean();
  const accountId = host!.hostProfile!.stripeAccountId!;

  let transferId: string | undefined;
  if (amount > 0) {
    try {
      // A transfer made last time whose result the database missed counts as this one, never paid twice.
      transferId = await existingTransfer(payout.id, booking.ref);
      if (!transferId) {
        const source = await sourceCharge(payout);
        const attempts = payout.transferAttempts ?? 0;
        const transfer = await stripe().transfers.create(
          {
            amount,
            currency: CHARGE_CURRENCY,
            destination: accountId,
            transfer_group: booking.ref,
            description: `Rento Vroom ${payout.type === 'TRIP' ? 'trip' : payout.type === 'EXTRA_CHARGE' ? 'extra charge' : 'cancellation fee'} payout for ${booking.ref}`,
            metadata: { payoutId: payout.id, bookingId: booking._id.toString(), bookingRef: booking.ref },
            ...(source && { source_transaction: source }),
          },
          // Stripe replays a key's first answer for 24 hours, refusals included, so a retry after a refusal
          // needs a new key. An unclear failure (a timeout or a 5xx) keeps the key, in case it went through.
          { idempotencyKey: attempts > 0 ? `payout-${payout.id}-${attempts}` : `payout-${payout.id}` },
        );
        transferId = transfer.id;
      }
    } catch (error) {
      const reason = error instanceof Stripe.errors.StripeError ? error.message : 'The transfer failed';
      const refused =
        error instanceof Stripe.errors.StripeError &&
        error.statusCode !== undefined &&
        error.statusCode < 500;
      // A run at the same moment may have sent it meanwhile: a paid payout stays paid.
      const failed = await PayoutModel.updateOne(
        { _id: payout._id, status: mongoose.trusted({ $nin: ['PAID', 'CANCELLED'] }) },
        {
          $set: { status: 'FAILED', failureReason: reason.slice(0, 300) },
          ...(refused && { $inc: { transferAttempts: 1 } }),
        },
      );
      if (failed.matchedCount === 0) return 'skipped';
      await alertStaff({
        type: 'PAYOUT_FAILED',
        title: `A payout to ${host?.firstName ?? 'a host'} failed`,
        body: `the ${formatNzdExact(amount)} payout for booking ${booking.ref} failed: ${reason}`,
        link: `/admin/payments?tab=payouts`,
        dedupeKey: `PAYOUT_FAILED:${payout.id}`,
      });
      throw error;
    }
  }

  const paid = await withTransaction(async (session) => {
    const before = await PayoutModel.findById(payout._id).select('status').session(session).lean();
    // Cancelled while its transfer was being made (its booking was cancelled that moment): owed back.
    if (before?.status === 'CANCELLED') {
      const sent = await sentAfterCancel(
        payout.toObject() as PayoutRecord,
        booking,
        { amount: Math.max(0, amount), transferId },
        session,
        now,
      );
      return sent ? true : null;
    }
    const updated = await PayoutModel.findOneAndUpdate(
      { _id: payout._id, status: mongoose.trusted({ $ne: 'PAID' }) },
      {
        $set: {
          status: 'PAID',
          paidAt: now,
          amountCents: Math.max(0, amount),
          deductions,
          ...(transferId && { stripeTransferId: transferId }),
        },
        $unset: { holdReason: 1, failureReason: 1 },
      },
      { new: true, session },
    );
    // What the Host owed was already taken off their balance when the deductions were reserved.
    if (!updated) return null;
    await notifyPaid(
      updated.toObject() as PayoutRecord,
      booking,
      host?.firstName ?? 'there',
      host?.hostProfile?.payoutDelayDays,
      session,
      host?.hostProfile?.gstRegistered,
    );
    return updated;
  });
  return paid ? 'paid' : 'skipped';
}

/** The day the money should reach the Host's bank: the transfer date plus Stripe's payout delay, in business days. */
export function expectedBankDate(paidAt: Date, delayDays = DEFAULT_BANK_DAYS): Date {
  const date = new Date(paidAt);
  let added = 0;
  while (added < delayDays) {
    date.setTime(date.getTime() + DAY_MS);
    const day = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short' }).format(
      date,
    );
    if (day !== 'Sat' && day !== 'Sun') added += 1;
  }
  return date;
}

/** A deduction in words, as the Host sees it on the earnings page and the payout email. */
export function deductionLabel(
  deduction: Pick<Deduction, 'type' | 'stripeRefundId'>,
  bookingRef?: string,
): string {
  if (deduction.type === 'HOST_CANCELLATION_FEE') return 'Host cancellation fee';
  // A trip payout sent before its booking was cancelled, owed back less the Host's share of the kept fee.
  if (deduction.type === 'HOST_FUNDED_REFUND' && isPayoutSentBack(deduction.stripeRefundId))
    return bookingRef ? `Payout already sent for ${bookingRef}` : 'A payout already sent';
  if (deduction.type === 'HOST_FUNDED_REFUND')
    return bookingRef ? `Refund for ${bookingRef}` : 'Refund to a guest';
  return 'Other deduction';
}

/** The references of the bookings deductions name, by booking id. */
async function bookingRefs(ids: (Id | undefined)[], session?: ClientSession): Promise<Map<string, string>> {
  const wanted = ids.filter((id): id is Id => id !== undefined);
  if (wanted.length === 0) return new Map();
  const bookings = await BookingModel.find({ _id: mongoose.trusted({ $in: wanted }) })
    .select('ref')
    .session(session ?? null)
    .lean();
  return new Map(bookings.map((booking) => [booking._id.toString(), booking.ref]));
}

async function notifyPaid(
  payout: PayoutRecord,
  booking: BookingRecord,
  firstName: string,
  delayDays: number | undefined,
  session: ClientSession,
  gstRegistered = false,
) {
  const refs = await bookingRefs(
    payout.deductions.map((deduction) => deduction.bookingId),
    session,
  );
  // A GST-registered Host's tax invoice for the commission names its supplier (plan §8.1, item 22).
  const business = gstRegistered ? (await getPlatformSettings()).business : undefined;
  const bank = expectedBankDate(payout.paidAt!, delayDays);
  const amount = formatNzdExact(payout.amountCents);
  await notify(
    {
      userId: payout.hostId,
      type: 'PAYOUT_PAID',
      title: `${amount} paid out for ${booking.ref}`,
      body: `Usually in your bank by ${formatNzDate(bank)}.`,
      link: '/host/earnings',
      email: {
        template: 'tripNotice',
        props: {
          firstName,
          heading: `${amount} is on its way`,
          paragraphs: [
            `Your payout for booking ${booking.ref}, the ${booking.vehicleSnapshot.title}, has been sent to your Stripe balance.`,
            `Stripe pays it into your bank account on its schedule, usually by ${formatNzDate(bank)}.`,
          ],
          rows: [
            ...(payout.grossCents !== undefined
              ? [{ label: 'Earned', value: formatNzdExact(payout.grossCents) }]
              : []),
            ...(payout.commissionCents !== undefined
              ? [
                  {
                    label: 'Platform commission',
                    value: `−${formatNzdExact(payout.commissionCents)} (incl. ${formatNzdExact(payout.commissionGstCents ?? 0)} GST)`,
                  },
                ]
              : []),
            ...(business && payout.commissionCents !== undefined
              ? [
                  {
                    label: 'Commission charged by',
                    value: business.gstNumber
                      ? `${business.legalName}, GST number ${business.gstNumber}`
                      : business.legalName,
                  },
                ]
              : []),
            // Each deduction on its own line (plan §8.1, items 10 and 15).
            ...payout.deductions.map((deduction) => ({
              label: deductionLabel(
                deduction,
                deduction.bookingId && refs.get(deduction.bookingId.toString()),
              ),
              value: `−${formatNzdExact(deduction.amountCents)}`,
            })),
            { label: 'Paid out', value: amount },
          ],
          buttonLabel: 'See your earnings',
          url: `${siteUrl()}/host/earnings`,
        },
      },
      dedupeKey: `PAYOUT_PAID:${payout._id.toString()}`,
    },
    { session },
  );
}

/** Tells a Host once a day at most that a payout waits for their payout setup. */
async function remindPayoutSetup(payout: PayoutDocument, booking: BookingRecord, now: Date) {
  const host = await UserModel.findById(payout.hostId).select('firstName').lean();
  await notify({
    userId: payout.hostId,
    type: 'PAYOUT_SETUP_NEEDED',
    title: 'Finish your payout setup to get paid',
    body: `Your payout for ${booking.ref} is waiting for your bank details with Stripe.`,
    link: '/host/earnings',
    email: {
      template: 'tripNotice',
      props: {
        firstName: host?.firstName ?? 'there',
        heading: 'Your payout is waiting',
        paragraphs: [
          `Your earnings for booking ${booking.ref} are ready, but we can't pay them until your payout setup with Stripe is finished.`,
          'It takes a few minutes: your bank account and a quick identity check.',
        ],
        buttonLabel: 'Finish payout setup',
        url: `${siteUrl()}/host/earnings`,
      },
    },
    dedupeKey: `PAYOUT_SETUP_NEEDED:${payout.hostId.toString()}:${nzDate(now)}`,
  });
}

/**
 * Holds a booking's unpaid payouts, e.g. when a card dispute opens (plan §8.1, item 12). One staff held
 * keeps its MANUAL hold: only staff release it.
 */
export async function holdBookingPayouts(bookingId: Id, reason: PayoutHoldReason, session?: ClientSession) {
  await PayoutModel.updateMany(
    {
      bookingId,
      status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }),
      holdReason: mongoose.trusted({ $ne: 'MANUAL' }),
    },
    { $set: { status: 'HELD', holdReason: reason } },
    { session },
  );
}

/** Sends held payouts again now that `reason` no longer holds them; any other hold still applies. */
export async function releaseHeldPayouts(
  filter: { hostId?: Id | string; bookingId?: Id | string },
  reason: PayoutHoldReason,
  { session, now = new Date() }: { session?: ClientSession; now?: Date } = {},
) {
  const held = await PayoutModel.find({ ...filter, status: 'HELD', holdReason: reason })
    .select('_id bookingId')
    .session(session ?? null)
    .lean();
  for (const payout of held) {
    await PayoutModel.updateOne(
      { _id: payout._id, status: 'HELD' },
      { $set: { status: 'SCHEDULED' }, $unset: { holdReason: 1 } },
      { session },
    );
    await queueTransfer(payout, now, session);
  }
  return held.length;
}

/** Paid payouts on each page of the Host's list. */
export const PAID_PAYOUTS_PAGE = 12;

/**
 * A Host's payouts for the earnings page (plan §8.1, item 19): those still to be sent, soonest first, then the
 * paid ones, newest first, a page at a time. With `cursor` (the last paid payout shown), only the next page of
 * paid ones. A payout not sent yet shows what it sends: less the deductions already reserved for it.
 */
export async function listHostPayouts(hostId: string, cursor?: string) {
  const host = await UserModel.findById(hostId).select('hostProfile').lean();
  const after = cursor
    ? await PayoutModel.findOne({ _id: cursor, hostId, status: 'PAID' }).select('paidAt').lean()
    : null;
  if (cursor && !after?.paidAt) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find those payouts.');
  const [upcoming, paidPage, paidCount] = await Promise.all([
    cursor
      ? []
      : PayoutModel.find({ hostId, status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }) })
          .sort({ scheduledFor: 1, _id: 1 })
          .lean<PayoutRecord[]>(),
    PayoutModel.find({
      hostId,
      status: 'PAID',
      ...(after?.paidAt && {
        $or: [
          { paidAt: mongoose.trusted({ $lt: after.paidAt }) },
          { paidAt: after.paidAt, _id: mongoose.trusted({ $lt: after._id }) },
        ],
      }),
    })
      .sort({ paidAt: -1, _id: -1 })
      .limit(PAID_PAYOUTS_PAGE + 1)
      .lean<PayoutRecord[]>(),
    PayoutModel.countDocuments({ hostId, status: 'PAID' }),
  ]);
  const paid = paidPage.slice(0, PAID_PAYOUTS_PAGE);
  const payouts = [...upcoming, ...paid];
  // The payouts' bookings, and those their deductions name.
  const bookings = await BookingModel.find({
    _id: mongoose.trusted({
      $in: payouts.flatMap((payout) => [
        payout.bookingId,
        ...payout.deductions.flatMap((deduction) => (deduction.bookingId ? [deduction.bookingId] : [])),
      ]),
    }),
  })
    .select('ref vehicleSnapshot.title startAt endAt')
    .lean();
  const refOf = (id: Id | undefined) => id && bookings.find((candidate) => candidate._id.equals(id))?.ref;
  const rows = payouts.map((payout) => {
    const booking = bookings.find((candidate) => candidate._id.equals(payout.bookingId));
    const reversed = (payout.reversals ?? []).reduce((sum, reversal) => sum + reversal.amountCents, 0);
    return {
      id: payout._id.toString(),
      type: payout.type,
      status: payout.status,
      ...(payout.holdReason && { holdReason: payout.holdReason }),
      // A paid payout's amount is what was sent, after its deductions.
      amountCents: payout.status === 'PAID' ? payout.amountCents : payout.amountCents - reservedCents(payout),
      ...(payout.grossCents !== undefined && { grossCents: payout.grossCents }),
      ...(payout.commissionCents !== undefined && { commissionCents: payout.commissionCents }),
      ...(payout.commissionGstCents !== undefined && { commissionGstCents: payout.commissionGstCents }),
      deductions: payout.deductions.map((deduction) => {
        const ref = refOf(deduction.bookingId);
        return {
          type: deduction.type,
          amountCents: deduction.amountCents,
          ...(ref && { bookingRef: ref }),
          ...(isPayoutSentBack(deduction.stripeRefundId) && { payoutSent: true }),
        };
      }),
      ...(reversed > 0 && { reversedCents: reversed }),
      scheduledFor: payout.scheduledFor.toISOString(),
      ...(payout.paidAt && {
        paidAt: payout.paidAt.toISOString(),
        expectedInBankBy: expectedBankDate(payout.paidAt, host?.hostProfile?.payoutDelayDays).toISOString(),
      }),
      // A scheduled payout's two dates (plan §8.1, item 19): the transfer, then the bank on Stripe's schedule.
      ...(payout.status === 'SCHEDULED' && {
        expectedInBankBy: expectedBankDate(
          payout.scheduledFor,
          host?.hostProfile?.payoutDelayDays,
        ).toISOString(),
      }),
      booking: {
        ref: booking?.ref ?? '',
        vehicleTitle: booking?.vehicleSnapshot.title ?? 'A car',
        start: booking?.startAt.toISOString() ?? payout.scheduledFor.toISOString(),
      },
    };
  });
  const last = paid.at(-1);
  return {
    payouts: rows,
    paidCount,
    ...(paidPage.length > PAID_PAYOUTS_PAGE && last && { nextCursor: last._id.toString() }),
  };
}

/** The deductions already taken for a payout still to be sent (reserved before its transfer). */
export const reservedCents = (payout: Pick<Payout, 'deductions' | 'deductionsReservedAt'>) =>
  payout.deductionsReservedAt
    ? (payout.deductions ?? []).reduce((sum, deduction) => sum + deduction.amountCents, 0)
    : 0;

/** The booking's trip payout while a Host-funded refund can still come off it: not sent, nor reserved for sending. */
const pendingTripPayout = (bookingId: Id, extraChargeId?: Id) => ({
  bookingId,
  // A refund of an extra charge comes off that charge's own payout (plan §8.1, item 11).
  ...(extraChargeId ? { type: 'EXTRA_CHARGE', extraChargeId } : { type: 'TRIP' }),
  status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }),
  deductionsReservedAt: mongoose.trusted({ $exists: false }),
});

/**
 * Whether a Host-funded refund on the booking still comes off its own trip payout (plan §8.1, item 15).
 * Once that payout is sent, or being sent, or the booking ended without one, the Host owes the refund.
 */
export async function tripPayoutPending(bookingId: Id, extraChargeId?: Id): Promise<boolean> {
  return Boolean(await PayoutModel.exists(pendingTripPayout(bookingId, extraChargeId)));
}

export type TransferReversal =
  | { reversed: true; payoutId: Id; stripeReversalId: string; amountCents: number }
  | { reversed: false; reason: string };

/**
 * Takes the Host's share of a refund they fund back from the booking's paid payout by reversing its Stripe
 * transfer, when staff choose to (plan §8.1, item 15): never more than what's left of the transfer. It's a
 * Stripe call, so it's made before the refund's transaction, which records it (recoverHostRefund).
 */
export async function reversePayoutTransfer(
  booking: BookingRecord,
  refund: { hostCents: number; stripeRefundId: string },
  extraChargeId?: Id,
): Promise<TransferReversal> {
  const payout = await PayoutModel.findOne({
    bookingId: booking._id,
    ...(extraChargeId
      ? { type: 'EXTRA_CHARGE', extraChargeId }
      : { type: mongoose.trusted({ $in: ['TRIP', 'CANCELLATION_FEE'] }) }),
    status: 'PAID',
    stripeTransferId: mongoose.trusted({ $exists: true }),
  })
    .sort({ paidAt: -1 })
    .lean<PayoutRecord>();
  if (!payout?.stripeTransferId) {
    return { reversed: false, reason: 'no transfer was made for this booking’s payout' };
  }
  const left =
    payout.amountCents - (payout.reversals ?? []).reduce((sum, reversal) => sum + reversal.amountCents, 0);
  if (left <= 0) return { reversed: false, reason: 'its transfer has already been taken back in full' };
  const amount = Math.min(refund.hostCents, left);
  try {
    const reversal = await stripe().transfers.createReversal(
      payout.stripeTransferId,
      {
        amount,
        metadata: {
          payoutId: payout._id.toString(),
          bookingId: booking._id.toString(),
          bookingRef: booking.ref,
          stripeRefundId: refund.stripeRefundId,
        },
      },
      { idempotencyKey: `reversal-${refund.stripeRefundId}` },
    );
    return { reversed: true, payoutId: payout._id, stripeReversalId: reversal.id, amountCents: amount };
  } catch (error) {
    logger.warn({ err: error, payoutId: payout._id.toString() }, 'Stripe did not reverse a payout transfer');
    return {
      reversed: false,
      reason: error instanceof Stripe.errors.StripeError ? error.message : 'Stripe didn’t answer',
    };
  }
}

/** How a Host-funded refund is recovered from the Host (plan §8.1, item 15). */
export interface HostRefundRecovery {
  /** THIS_PAYOUT: it comes off the booking's own payout, still to be sent. */
  recoveredFrom: 'THIS_PAYOUT' | 'NEXT_PAYOUT' | 'REVERSE_TRANSFER';
  reversedCents?: number;
  /** What comes off the Host's next payout. */
  owedCents?: number;
  /** Why the transfer wasn't reversed when staff asked for it. */
  note?: string;
}

/**
 * Records how a Host-funded refund is recovered (plan §8.1, item 15), inside the refund's transaction: the
 * Host's share of it (`hostCents`) comes off the booking's own payout while it's still to be sent; otherwise
 * it's taken back from the transfer (when staff chose it and Stripe agreed) and the rest owed, to come off the
 * Host's next payout as its own line. The Host is told.
 */
export async function recoverHostRefund(
  booking: BookingRecord,
  refund: { amountCents: number; hostCents: number; stripeRefundId: string },
  reversal: TransferReversal | undefined,
  session: ClientSession,
  now = new Date(),
  extraChargeId?: Id,
): Promise<HostRefundRecovery> {
  // Touching the trip payout makes a reservation running at the same moment conflict with this transaction,
  // so the refund is counted once: by the payout's own deductions, or as owed here.
  const pending = await PayoutModel.updateOne(
    pendingTripPayout(booking._id, extraChargeId),
    { $set: { updatedAt: new Date() } },
    { session, timestamps: false },
  );
  if (pending.matchedCount > 0) {
    await notifyRefundRecovered(booking, refund, { thisPayout: true }, session, Boolean(extraChargeId));
    return { recoveredFrom: 'THIS_PAYOUT' };
  }

  const reversed = reversal?.reversed ? reversal.amountCents : 0;
  if (reversal?.reversed) {
    await PayoutModel.updateOne(
      {
        _id: reversal.payoutId,
        'reversals.stripeReversalId': mongoose.trusted({ $ne: reversal.stripeReversalId }),
      },
      {
        $push: {
          reversals: {
            stripeReversalId: reversal.stripeReversalId,
            amountCents: reversal.amountCents,
            stripeRefundId: refund.stripeRefundId,
            createdAt: now,
          },
        },
      },
      { session },
    );
  }
  const owed = refund.hostCents - reversed;
  if (owed > 0) {
    await UserModel.updateOne(
      {
        _id: booking.hostId,
        'hostProfile.refundsOwed.stripeRefundId': mongoose.trusted({ $ne: refund.stripeRefundId }),
      },
      {
        $push: {
          'hostProfile.refundsOwed': {
            bookingId: booking._id,
            stripeRefundId: refund.stripeRefundId,
            amountCents: owed,
            createdAt: now,
          },
        },
      },
      { session },
    );
  }
  await notifyRefundRecovered(
    booking,
    refund,
    { reversedCents: reversed, owedCents: owed },
    session,
    Boolean(extraChargeId),
  );
  return {
    recoveredFrom: reversed > 0 ? 'REVERSE_TRANSFER' : 'NEXT_PAYOUT',
    ...(reversed > 0 && { reversedCents: reversed }),
    ...(owed > 0 && { owedCents: owed }),
    ...(reversal &&
      !reversal.reversed && {
        note: `Stripe didn’t reverse the transfer (${reversal.reason}), so it comes off the Host’s next payout instead.`,
      }),
  };
}

/**
 * Tells the Host a refund they fund comes off their payout for it, still to be sent (`thisPayout`), was taken
 * back from their payout, or comes off their next one.
 */
async function notifyRefundRecovered(
  booking: BookingRecord,
  refund: { amountCents: number; hostCents: number; stripeRefundId: string },
  {
    reversedCents = 0,
    owedCents = 0,
    thisPayout = false,
  }: { reversedCents?: number; owedCents?: number; thisPayout?: boolean },
  session: ClientSession,
  extraCharge = false,
) {
  const host = await UserModel.findById(booking.hostId).select('firstName').session(session).lean();
  const amount = formatNzdExact(refund.amountCents);
  // The Host pays their share of it: the platform covers its commission (plan §8.1, item 15).
  const partly = refund.hostCents < refund.amountCents;
  const share = formatNzdExact(refund.hostCents);
  const subject = partly ? `${share} of a ${amount} refund` : `A ${amount} refund`;
  const reversed = formatNzdExact(reversedCents);
  const owed = formatNzdExact(owedCents);
  const how = [
    ...(thisPayout
      ? [
          `${share} comes off your payout for this ${extraCharge ? 'charge' : 'booking'}, still to be sent, shown as its own line.`,
        ]
      : []),
    ...(reversedCents > 0 ? [`${reversed} has been taken back from your payout for it.`] : []),
    ...(owedCents > 0
      ? [`${reversedCents > 0 ? 'The other ' : ''}${owed} comes off your next payout, shown as its own line.`]
      : []),
  ];
  await notify(
    {
      userId: booking.hostId,
      type: 'HOST_REFUND_RECOVERED',
      title: thisPayout
        ? `${subject} for ${booking.ref} comes off your payout for it`
        : owedCents > 0
          ? `${subject} for ${booking.ref} comes off your next payout`
          : `${subject} for ${booking.ref} was taken back from your payout`,
      body: how.join(' '),
      link: '/host/earnings',
      email: {
        template: 'tripNotice',
        props: {
          firstName: host?.firstName ?? 'there',
          heading: `A refund for booking ${booking.ref}`,
          paragraphs: [
            `We’ve refunded the guest ${amount} for booking ${booking.ref}, the ${booking.vehicleSnapshot.title}. It’s a refund of ${extraCharge ? 'an extra charge' : 'rental'} you ${thisPayout ? 'are being' : 'were'} paid, so it’s funded by you as the Host.`,
            ...(partly
              ? [`You pay your share of it, ${share}: Rento Vroom covers its commission on the rest.`]
              : []),
            ...how,
            'If you have questions about it, reply to this email.',
          ],
          rows: [
            { label: 'Booking', value: booking.ref },
            { label: 'Refund', value: amount },
            ...(partly ? [{ label: 'Your share', value: share }] : []),
            ...(reversedCents > 0 ? [{ label: 'Taken back from your payout', value: `−${reversed}` }] : []),
            ...(owedCents > 0 ? [{ label: 'Off your next payout', value: `−${owed}` }] : []),
            ...(thisPayout ? [{ label: 'Off your payout for it', value: `−${share}` }] : []),
          ],
          buttonLabel: 'See your earnings',
          url: `${siteUrl()}/host/earnings`,
        },
      },
      dedupeKey: `HOST_REFUND_RECOVERED:${refund.stripeRefundId}`,
    },
    { session },
  );
}

/**
 * A Host-funded refund failed (plan §8.1, items 15 and 21): what the Host still owed for it is dropped, and
 * what was already taken from them, off a payout or back from a transfer, is returned for staff to give
 * back.
 */
export async function hostRefundFailed(
  hostId: Id,
  stripeRefundId: string,
  session: ClientSession,
): Promise<{ droppedCents: number; deductedCents: number; reversedCents: number }> {
  const host = await UserModel.findById(hostId).select('hostProfile.refundsOwed').session(session).lean();
  const droppedCents = (host?.hostProfile?.refundsOwed ?? [])
    .filter((owed) => owed.stripeRefundId === stripeRefundId)
    .reduce((sum, owed) => sum + owed.amountCents, 0);
  if (droppedCents > 0) {
    await UserModel.updateOne(
      { _id: hostId },
      { $pull: { 'hostProfile.refundsOwed': { stripeRefundId } } },
      { session },
    );
  }
  const payouts = await PayoutModel.find({
    hostId,
    status: mongoose.trusted({ $ne: 'CANCELLED' }),
    $or: [{ 'deductions.stripeRefundId': stripeRefundId }, { 'reversals.stripeRefundId': stripeRefundId }],
  })
    .session(session)
    .lean<PayoutRecord[]>();
  // A deduction counts once it's paid, or reserved for a transfer under way.
  const deductedCents = payouts
    .filter((payout) => payout.status === 'PAID' || payout.deductionsReservedAt)
    .flatMap((payout) => payout.deductions)
    .filter((deduction) => deduction.stripeRefundId === stripeRefundId)
    .reduce((sum, deduction) => sum + deduction.amountCents, 0);
  const reversedCents = payouts
    .flatMap((payout) => payout.reversals ?? [])
    .filter((reversal) => reversal.stripeRefundId === stripeRefundId)
    .reduce((sum, reversal) => sum + reversal.amountCents, 0);
  return { droppedCents, deductedCents, reversedCents };
}
