import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { PaymentModel, type Payment } from '../payments/payment.model.js';
import { queueTransfer } from '../payouts/payouts.service.js';
import { PayoutModel, type Payout } from '../payouts/payout.model.js';
import { UserModel } from '../users/user.model.js';
import type {
  adminPaymentSchema,
  adminPayoutSchema,
  paymentListQuerySchema,
  payoutListQuerySchema,
} from './admin-ops.schemas.js';

/*
 * Payments and payouts in the staff portal (spec §18; plan §8.1, §9 Days 19–23): every payment, failed
 * payments and unpaid extra charges, refunds that failed, card disputes, and Host payouts that are
 * scheduled, held, paid or failed, with a hold staff can put on or take off and a retry for a failed one.
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
