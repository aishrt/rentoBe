import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { JobModel } from '../../jobs/job.model.js';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type ExtraCharge } from '../bookings/booking.model.js';
import { IncidentModel } from '../incidents/incident.model.js';
import { PaymentModel, type Payment, type Refund } from '../payments/payment.model.js';
import { queueTransfer } from '../payouts/payouts.service.js';
import { PayoutModel, type Payout } from '../payouts/payout.model.js';
import { UserModel } from '../users/user.model.js';
import type {
  adminExtraChargeRowSchema,
  adminPaymentSchema,
  adminPayoutSchema,
  adminRefundRowSchema,
  extraChargeListQuerySchema,
  paymentListQuerySchema,
  payoutListQuerySchema,
  refundListQuerySchema,
} from './admin-ops.schemas.js';

/*
 * Payments and payouts in the staff portal (spec §18; plan §8.1, §9 Days 19–23): every payment, failed
 * payments and unpaid extra charges, every refund with who funds it, refunds that failed, card disputes,
 * and Host payouts that are scheduled, held, paid or failed, with a hold staff can put on or take off and a
 * retry for a failed one.
 */

type Id = Types.ObjectId;
type PaymentRecord = Payment & { _id: Id };
type PayoutRecord = Payout & { _id: Id };

const PAGE_SIZE = 25;

async function bookingsFor(ids: Id[]) {
  const bookings = await BookingModel.find({ _id: mongoose.trusted({ $in: ids }) })
    .select('ref guestId hostId')
    .lean();
  const people = await UserModel.find({
    _id: mongoose.trusted({ $in: bookings.flatMap((booking) => [booking.guestId, booking.hostId]) }),
  })
    .select('firstName lastName')
    .lean();
  const name = (id: Id | undefined) => {
    const person = id && people.find((candidate) => candidate._id.equals(id));
    return person ? `${person.firstName} ${person.lastName}` : 'Former member';
  };
  return (id: Id) => {
    const booking = bookings.find((candidate) => candidate._id.equals(id));
    return {
      ref: booking?.ref ?? '',
      guestId: booking?.guestId,
      guestName: name(booking?.guestId),
      hostId: booking?.hostId,
      hostName: name(booking?.hostId),
    };
  };
}

export async function paymentRows(payments: PaymentRecord[]): Promise<z.infer<typeof adminPaymentSchema>[]> {
  const booking = await bookingsFor(payments.map((payment) => payment.bookingId));
  return payments.map((payment) => {
    const { ref, guestName } = booking(payment.bookingId);
    return {
      id: payment._id.toString(),
      bookingRef: ref,
      guestName,
      type: payment.type,
      amountCents: payment.amountCents,
      status: payment.status,
      ...(payment.method && { method: payment.method }),
      ...(payment.failureReason && { failureReason: payment.failureReason }),
      refundedCents: payment.refunds
        .filter((refund) => refund.status !== 'FAILED')
        .reduce((sum, refund) => sum + refund.amountCents, 0),
      refunds: payment.refunds.map((refund) => ({
        amountCents: refund.amountCents,
        reason: refund.reason,
        fundedBy: refund.fundedBy,
        status: refund.status,
        ...(refund.failureReason && { failureReason: refund.failureReason }),
        at: refund.createdAt.toISOString(),
      })),
      ...(payment.dispute && {
        dispute: {
          status: payment.dispute.status,
          ...(payment.dispute.reason && { reason: payment.dispute.reason }),
          ...(payment.dispute.dueBy && { dueBy: payment.dispute.dueBy.toISOString() }),
        },
      }),
      createdAt: payment.createdAt.toISOString(),
    };
  });
}

export async function payoutRows(payouts: PayoutRecord[]): Promise<z.infer<typeof adminPayoutSchema>[]> {
  const booking = await bookingsFor(payouts.map((payout) => payout.bookingId));
  const hosts = await UserModel.find({
    _id: mongoose.trusted({ $in: payouts.map((payout) => payout.hostId) }),
  })
    .select('firstName lastName')
    .lean();
  return payouts.map((payout) => {
    const host = hosts.find((candidate) => candidate._id.equals(payout.hostId));
    return {
      id: payout._id.toString(),
      bookingRef: booking(payout.bookingId).ref,
      host: {
        id: payout.hostId.toString(),
        name: host ? `${host.firstName} ${host.lastName}` : 'Former member',
      },
      type: payout.type,
      status: payout.status,
      ...(payout.holdReason && { holdReason: payout.holdReason }),
      amountCents: payout.amountCents,
      deductedCents: payout.deductions.reduce((sum, deduction) => sum + deduction.amountCents, 0),
      scheduledFor: payout.scheduledFor.toISOString(),
      ...(payout.paidAt && { paidAt: payout.paidAt.toISOString() }),
      ...(payout.failureReason && { failureReason: payout.failureReason }),
    };
  });
}

/** GET /admin/payments: every payment, or the failed ones, the disputed ones, or those with a failed refund. */
export async function listPayments(query: z.infer<typeof paymentListQuerySchema>) {
  const filter: Record<string, unknown> = {
    ...(query.status && { status: query.status }),
    ...(query.type && { type: query.type }),
  };
  if (query.view === 'failed') filter.status = 'FAILED';
  if (query.view === 'disputed') filter.dispute = mongoose.trusted({ $exists: true });
  if (query.view === 'refunds-failed') filter['refunds.status'] = 'FAILED';
  const [payments, total] = await Promise.all([
    PaymentModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<PaymentRecord[]>(),
    PaymentModel.countDocuments(filter),
  ]);
  return { payments: await paymentRows(payments), total, page: query.page };
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bookings whose reference has this in it, for a search by reference. */
async function bookingIdsByRef(text: string): Promise<Id[]> {
  const bookings = await BookingModel.find({ ref: new RegExp(escape(text.toUpperCase())) })
    .select('_id')
    .limit(200)
    .lean();
  return bookings.map((booking) => booking._id);
}

interface HostRecovery {
  deductedCents: number;
  reversedCents: number;
  owedCents: number;
}

/**
 * How each Host-funded refund has been recovered from its Host (plan §8.1, item 15), by Stripe refund: taken
 * off a payout (its own trip's before that was sent, or a later one), taken back from a paid transfer, and
 * what's still owed for the next payout. A cancelled payout gave its deductions back, so it doesn't count.
 */
async function hostRecoveries(stripeRefundIds: string[]): Promise<Map<string, HostRecovery>> {
  const recovered = new Map<string, HostRecovery>();
  if (stripeRefundIds.length === 0) return recovered;
  const wanted = new Set(stripeRefundIds);
  const add = (id: string | undefined, key: keyof HostRecovery, cents: number) => {
    if (!id || !wanted.has(id)) return;
    const found = recovered.get(id) ?? { deductedCents: 0, reversedCents: 0, owedCents: 0 };
    found[key] += cents;
    recovered.set(id, found);
  };
  const [payouts, hosts] = await Promise.all([
    PayoutModel.find({
      $or: [
        { 'deductions.stripeRefundId': mongoose.trusted({ $in: stripeRefundIds }) },
        { 'reversals.stripeRefundId': mongoose.trusted({ $in: stripeRefundIds }) },
      ],
    })
      .select('status deductions reversals')
      .lean<PayoutRecord[]>(),
    UserModel.find({ 'hostProfile.refundsOwed.stripeRefundId': mongoose.trusted({ $in: stripeRefundIds }) })
      .select('hostProfile.refundsOwed')
      .lean(),
  ]);
  for (const payout of payouts) {
    if (payout.status !== 'CANCELLED') {
      for (const deduction of payout.deductions) {
        add(deduction.stripeRefundId, 'deductedCents', deduction.amountCents);
      }
    }
    for (const reversal of payout.reversals ?? []) {
      add(reversal.stripeRefundId, 'reversedCents', reversal.amountCents);
    }
  }
  for (const host of hosts) {
    for (const owed of host.hostProfile?.refundsOwed ?? []) {
      add(owed.stripeRefundId, 'owedCents', owed.amountCents);
    }
  }
  return recovered;
}

interface RefundRecord {
  _id: Id;
  bookingId: Id;
  type: Payment['type'];
  refund: Refund & { _id: Id };
}

/**
 * GET /admin/refunds (plan §12.6, Refunds): every refund on every payment, newest first, by status, who funds
 * it and why it was made, or by booking reference. Each says who issued it, and a Host-funded one how it has
 * been recovered from the Host. Like payments, it needs the refunds permission.
 */
export async function listRefunds(
  query: z.infer<typeof refundListQuerySchema>,
): Promise<{ refunds: z.infer<typeof adminRefundRowSchema>[]; total: number; page: number }> {
  const bookingIds = query.q ? await bookingIdsByRef(query.q) : undefined;
  const [result] = await PaymentModel.aggregate<{ rows: RefundRecord[]; total: { count: number }[] }>([
    { $match: { 'refunds.0': { $exists: true }, ...(bookingIds && { bookingId: { $in: bookingIds } }) } },
    { $unwind: '$refunds' },
    {
      $match: {
        ...(query.status && { 'refunds.status': query.status }),
        ...(query.fundedBy && { 'refunds.fundedBy': query.fundedBy }),
        ...(query.kind && { 'refunds.kind': query.kind }),
      },
    },
    { $sort: { 'refunds.createdAt': -1, 'refunds._id': -1 } },
    {
      $facet: {
        rows: [
          { $skip: (query.page - 1) * PAGE_SIZE },
          { $limit: PAGE_SIZE },
          { $project: { bookingId: 1, type: 1, refund: '$refunds' } },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const rows = result?.rows ?? [];
  const [booking, issuers, recoveries] = await Promise.all([
    bookingsFor(rows.map((row) => row.bookingId)),
    UserModel.find({ _id: mongoose.trusted({ $in: rows.flatMap((row) => row.refund.issuedBy ?? []) }) })
      .select('firstName lastName')
      .lean(),
    hostRecoveries(
      rows.flatMap(({ refund }) =>
        refund.fundedBy === 'HOST' && refund.stripeRefundId ? [refund.stripeRefundId] : [],
      ),
    ),
  ]);
  return {
    refunds: rows.map(({ _id, bookingId, type, refund }) => {
      const { ref, guestId, guestName } = booking(bookingId);
      const issuer = refund.issuedBy && issuers.find((user) => user._id.equals(refund.issuedBy));
      const recovery =
        refund.fundedBy === 'HOST' && refund.stripeRefundId
          ? recoveries.get(refund.stripeRefundId)
          : undefined;
      return {
        id: refund._id.toString(),
        paymentId: _id.toString(),
        paymentType: type,
        bookingRef: ref,
        guest: { id: guestId?.toString() ?? '', name: guestName },
        amountCents: refund.amountCents,
        reason: refund.reason,
        ...(refund.kind && { kind: refund.kind }),
        fundedBy: refund.fundedBy,
        status: refund.status,
        ...(refund.failureReason && { failureReason: refund.failureReason }),
        ...(refund.issuedBy && {
          issuedBy: {
            id: refund.issuedBy.toString(),
            name: issuer ? `${issuer.firstName} ${issuer.lastName}` : 'Former staff member',
          },
        }),
        ...(recovery && { hostRecovery: recovery }),
        createdAt: refund.createdAt.toISOString(),
      };
    }),
    total: result?.total[0]?.count ?? 0,
    page: query.page,
  };
}

interface ChargeRecord {
  _id: Id;
  ref: string;
  guestId: Id;
  charge: ExtraCharge & { _id: Id };
}

/**
 * GET /admin/extra-charges (plan §8.1, item 6): extra charges still unpaid on any booking, newest first:
 * those the saved card is still being tried for, and those that failed. Each has its last failure, the
 * tries so far and the next one while their records are kept, and the case it was charged from.
 */
export async function listUnpaidExtraCharges(
  query: z.infer<typeof extraChargeListQuerySchema>,
): Promise<{ charges: z.infer<typeof adminExtraChargeRowSchema>[]; total: number; page: number }> {
  const statuses = query.status ? [query.status] : ['PENDING', 'FAILED'];
  const [result] = await BookingModel.aggregate<{ rows: ChargeRecord[]; total: { count: number }[] }>([
    { $match: { 'extraCharges.status': { $in: statuses } } },
    { $unwind: '$extraCharges' },
    { $match: { 'extraCharges.status': { $in: statuses } } },
    { $sort: { 'extraCharges._id': -1 } },
    {
      $facet: {
        rows: [
          { $skip: (query.page - 1) * PAGE_SIZE },
          { $limit: PAGE_SIZE },
          { $project: { ref: 1, guestId: 1, charge: '$extraCharges' } },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const rows = result?.rows ?? [];
  const [guests, payments, incidents, jobs] = await Promise.all([
    UserModel.find({ _id: mongoose.trusted({ $in: rows.map((row) => row.guestId) }) })
      .select('firstName lastName')
      .lean(),
    PaymentModel.find({
      type: 'EXTRA_CHARGE',
      extraChargeId: mongoose.trusted({ $in: rows.map((row) => row.charge._id) }),
    })
      .select('extraChargeId status failureReason')
      .sort({ createdAt: -1 })
      .lean(),
    IncidentModel.find({ _id: mongoose.trusted({ $in: rows.flatMap((row) => row.charge.incidentId ?? []) }) })
      .select('caseRef')
      .lean(),
    // Each try is a job naming the charge and its number; finished jobs are kept for 30 days.
    JobModel.find({
      type: 'extraCharge.collect',
      refId: mongoose.trusted({ $in: rows.map((row) => row._id.toString()) }),
    })
      .select('payload status runAt')
      .lean(),
  ]);
  return {
    charges: rows.map(({ ref, guestId, charge }) => {
      const guest = guests.find((candidate) => candidate._id.equals(guestId));
      const payment = payments.find((candidate) => candidate.extraChargeId?.equals(charge._id));
      const incident = charge.incidentId && incidents.find((item) => item._id.equals(charge.incidentId));
      const tries = jobs.flatMap((job) => {
        const payload = job.payload as { chargeId?: string; attempt?: number } | undefined;
        return payload?.chargeId === charge._id.toString()
          ? [{ attempt: payload.attempt ?? 1, status: job.status, runAt: job.runAt }]
          : [];
      });
      const made = tries.filter((job) => job.status === 'DONE' || job.status === 'FAILED');
      const next = tries.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING');
      return {
        id: charge._id.toString(),
        bookingRef: ref,
        guest: {
          id: guestId.toString(),
          name: guest ? `${guest.firstName} ${guest.lastName}` : 'Former member',
        },
        type: charge.type,
        description: charge.description,
        amountCents: charge.amountCents,
        status: charge.status,
        ...(payment && { paymentStatus: payment.status }),
        ...(payment?.failureReason && { failureReason: payment.failureReason }),
        ...(made.length > 0 && { attempts: Math.max(...made.map((job) => job.attempt)) }),
        ...(next && { nextTryAt: next.runAt.toISOString() }),
        ...(incident && { incidentRef: incident.caseRef }),
        // Extra charges have no date of their own: their id records when they were added.
        createdAt: charge._id.getTimestamp().toISOString(),
      };
    }),
    total: result?.total[0]?.count ?? 0,
    page: query.page,
  };
}

/** GET /admin/payouts: Host payouts by status, next due first for those still to go. */
export async function listPayouts(query: z.infer<typeof payoutListQuerySchema>) {
  const filter = query.status ? { status: query.status } : {};
  const upcoming = query.status && ['SCHEDULED', 'HELD'].includes(query.status);
  const [payouts, total] = await Promise.all([
    PayoutModel.find(filter)
      .sort({ scheduledFor: upcoming ? 1 : -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<PayoutRecord[]>(),
    PayoutModel.countDocuments(filter),
  ]);
  return { payouts: await payoutRows(payouts), total, page: query.page };
}

async function findPayout(payoutId: string) {
  const payout = mongoose.isValidObjectId(payoutId)
    ? await PayoutModel.findById(payoutId).lean<PayoutRecord>()
    : null;
  if (!payout) throw new HttpError(404, 'NOT_FOUND', 'No such payout.');
  return payout;
}

async function onePayout(payoutId: Id) {
  const [row] = await payoutRows([(await PayoutModel.findById(payoutId).lean<PayoutRecord>())!]);
  return row!;
}

/** POST /admin/payouts/{id}/hold: staff hold a payout that hasn't gone, until they release it. */
export async function holdPayout(staffId: string, payoutId: string, reason: string, ip?: string) {
  const payout = await findPayout(payoutId);
  if (!['SCHEDULED', 'HELD', 'FAILED'].includes(payout.status)) {
    throw new HttpError(409, 'NOT_HOLDABLE', 'This payout has already been paid or cancelled.');
  }
  await PayoutModel.updateOne(
    { _id: payout._id, status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }) },
    { $set: { status: 'HELD', holdReason: 'MANUAL' } },
  );
  await recordAudit({
    actorId: staffId,
    action: 'payout.held',
    entity: 'payout',
    entityId: payoutId,
    before: { status: payout.status, ...(payout.holdReason && { holdReason: payout.holdReason }) },
    after: { status: 'HELD', holdReason: 'MANUAL', reason },
    ...(ip && { ip }),
  });
  return onePayout(payout._id);
}

/**
 * POST /admin/payouts/{id}/release: a held payout is checked again now. A hold that still applies (an open
 * incident, a dispute, unfinished payout setup) puts it back on hold.
 */
export async function releasePayout(staffId: string, payoutId: string, ip?: string, now = new Date()) {
  const payout = await findPayout(payoutId);
  if (payout.status !== 'HELD') throw new HttpError(409, 'NOT_HELD', 'This payout isn’t on hold.');
  await PayoutModel.updateOne(
    { _id: payout._id, status: 'HELD' },
    { $set: { status: 'SCHEDULED' }, $unset: { holdReason: 1 } },
  );
  await queueTransfer(payout, now);
  await recordAudit({
    actorId: staffId,
    action: 'payout.released',
    entity: 'payout',
    entityId: payoutId,
    before: { status: 'HELD', holdReason: payout.holdReason },
    after: { status: 'SCHEDULED' },
    ...(ip && { ip }),
  });
  return onePayout(payout._id);
}

/** POST /admin/payouts/{id}/retry: a payout Stripe refused, sent again once the problem is fixed. */
export async function retryPayout(staffId: string, payoutId: string, ip?: string, now = new Date()) {
  const payout = await findPayout(payoutId);
  if (payout.status !== 'FAILED')
    throw new HttpError(409, 'NOT_FAILED', 'Only a failed payout can be retried.');
  await PayoutModel.updateOne({ _id: payout._id, status: 'FAILED' }, { $set: { status: 'SCHEDULED' } });
  await queueTransfer(payout, now);
  await recordAudit({
    actorId: staffId,
    action: 'payout.retried',
    entity: 'payout',
    entityId: payoutId,
    ...(ip && { ip }),
  });
  return onePayout(payout._id);
}
