import mongoose, { type ClientSession, type Types } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { CHARGE_CURRENCY, stripe } from '../../integrations/stripe.js';
import { logger } from '../../integrations/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { formatNzDate, formatNzdExact } from '../../lib/format.js';
import { nzDate } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { keptFeeCommission } from '../bookings/policies.js';
import { IncidentModel, OPEN_INCIDENT_STATUSES } from '../incidents/incident.model.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { notify } from '../notifications/notify.js';
import { PaymentModel } from '../payments/payment.model.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { UserModel } from '../users/user.model.js';
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
const gstIn = (cents: number, ratePct: number) => Math.round((cents * ratePct) / (100 + ratePct));

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

/**
 * A booking ended: an unpaid TRIP payout is cancelled, and the Host's share of a kept Guest cancellation
 * fee (no-shows included) becomes a CANCELLATION_FEE payout, paid when the trip's would have been
 * (plan §4.2, §8.1 item 16).
 */
export async function replaceTripPayout(booking: BookingRecord, session: ClientSession, now = new Date()) {
  await PayoutModel.updateOne(
    { bookingId: booking._id, type: 'TRIP', status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD'] }) },
    { $set: { status: 'CANCELLED' }, $unset: { holdReason: 1 } },
    { session },
  );
  const share = booking.hostShareCents ?? 0;
  if (share <= 0) return;
  if (await PayoutModel.exists({ bookingId: booking._id, type: 'CANCELLATION_FEE' }).session(session)) return;
  const settings = await getPlatformSettings();
  const scheduledFor = new Date(
    Math.max(booking.startAt.getTime() + PAYOUT_AFTER_START_HOURS * HOUR_MS, now.getTime()),
  );
  const commission = keptFeeCommission(booking);
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
          status: 'SUCCEEDED',
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
 * Host-funded refunds on the booking made after its payout was scheduled reduce a TRIP payout, and Host
 * cancellation fees owed come off any payout (plan §8.1, items 10 and 15). Never below zero: anything left
 * stays owed.
 */
async function deductionsFor(payout: PayoutDocument, booking: BookingRecord): Promise<Deduction[]> {
  const deductions: Deduction[] = [];
  let left = payout.amountCents;
  if (payout.type === 'TRIP') {
    const payments = await PaymentModel.find({ bookingId: booking._id, type: 'BOOKING' }).lean();
    const hostFunded = payments
      .flatMap((payment) => payment.refunds)
      .filter((refund) => refund.fundedBy === 'HOST' && refund.status !== 'FAILED')
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const take = Math.min(left, hostFunded);
    if (take > 0) {
      deductions.push({ type: 'HOST_FUNDED_REFUND', bookingId: booking._id, amountCents: take });
      left -= take;
    }
  }
  const host = await UserModel.findById(payout.hostId).select('hostProfile.feesOwedCents').lean();
  const owed = Math.min(left, host?.hostProfile?.feesOwedCents ?? 0);
  if (owed > 0) deductions.push({ type: 'HOST_CANCELLATION_FEE', amountCents: owed });
  return deductions;
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
    await PayoutModel.updateOne(
      { _id: payout._id, status: mongoose.trusted({ $ne: 'PAID' }) },
      { $set: { status: 'CANCELLED' } },
    );
    return 'skipped';
  }

  const hold = await holdFor(payout, booking);
  if (hold) {
    await PayoutModel.updateOne(
      { _id: payout._id, status: mongoose.trusted({ $ne: 'PAID' }) },
      { $set: { status: 'HELD', holdReason: hold } },
    );
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

  const deductions = await deductionsFor(payout, booking);
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
      await PayoutModel.updateOne(
        { _id: payout._id },
        {
          $set: { status: 'FAILED', failureReason: reason.slice(0, 300) },
          ...(refused && { $inc: { transferAttempts: 1 } }),
        },
      );
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
    if (!updated) return null;
    const fees = deductions.find((deduction) => deduction.type === 'HOST_CANCELLATION_FEE')?.amountCents ?? 0;
    if (fees > 0) {
      await UserModel.updateOne(
        { _id: payout.hostId },
        { $inc: { 'hostProfile.feesOwedCents': -fees } },
        { session },
      );
    }
    await notifyPaid(
      updated.toObject() as PayoutRecord,
      booking,
      host?.firstName ?? 'there',
      host?.hostProfile?.payoutDelayDays,
      session,
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

async function notifyPaid(
  payout: PayoutRecord,
  booking: BookingRecord,
  firstName: string,
  delayDays: number | undefined,
  session: ClientSession,
) {
  const deducted = payout.deductions.reduce((sum, deduction) => sum + deduction.amountCents, 0);
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
            ...(deducted > 0 ? [{ label: 'Deductions', value: `−${formatNzdExact(deducted)}` }] : []),
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

/** Holds a booking's unpaid payouts, e.g. when a card dispute opens (plan §8.1, item 12). */
export async function holdBookingPayouts(bookingId: Id, reason: PayoutHoldReason, session?: ClientSession) {
  await PayoutModel.updateMany(
    { bookingId, status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }) },
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

/** A Host's payouts for the earnings page: upcoming first, then paid, newest first. */
export async function listHostPayouts(hostId: string) {
  const host = await UserModel.findById(hostId).select('hostProfile').lean();
  const payouts = await PayoutModel.find({ hostId, status: mongoose.trusted({ $ne: 'CANCELLED' }) })
    .sort({ scheduledFor: -1 })
    .limit(200)
    .lean<PayoutRecord[]>();
  const bookings = await BookingModel.find({
    _id: mongoose.trusted({ $in: payouts.map((payout) => payout.bookingId) }),
  })
    .select('ref vehicleSnapshot.title startAt endAt')
    .lean();
  return payouts.map((payout) => {
    const booking = bookings.find((candidate) => candidate._id.equals(payout.bookingId));
    return {
      id: payout._id.toString(),
      type: payout.type,
      status: payout.status,
      ...(payout.holdReason && { holdReason: payout.holdReason }),
      amountCents: payout.amountCents,
      ...(payout.grossCents !== undefined && { grossCents: payout.grossCents }),
      ...(payout.commissionCents !== undefined && { commissionCents: payout.commissionCents }),
      ...(payout.commissionGstCents !== undefined && { commissionGstCents: payout.commissionGstCents }),
      deductions: payout.deductions.map((deduction) => ({
        type: deduction.type,
        amountCents: deduction.amountCents,
      })),
      scheduledFor: payout.scheduledFor.toISOString(),
      ...(payout.paidAt && {
        paidAt: payout.paidAt.toISOString(),
        expectedInBankBy: expectedBankDate(payout.paidAt, host?.hostProfile?.payoutDelayDays).toISOString(),
      }),
      booking: {
        ref: booking?.ref ?? '',
        vehicleTitle: booking?.vehicleSnapshot.title ?? 'A car',
        start: booking?.startAt.toISOString() ?? payout.scheduledFor.toISOString(),
      },
    };
  });
}
