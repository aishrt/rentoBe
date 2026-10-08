import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { nzDate } from '../../lib/nz-time.js';
import { BookingModel } from '../bookings/booking.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { UserModel } from '../users/user.model.js';
import type { exportQuerySchema, platformReportSchema } from './admin-ops.schemas.js';
import { nzDayStart } from './admin-bookings.service.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Platform reports (spec §18; plan §9 Days 19–23), admin only: bookings, revenue, fees, payouts,
 * cancellations and a GST summary for a range of NZ days, built with MongoDB aggregations, and each as a
 * CSV download. Money on trips is counted by the trip's start date, as the Hosts' earnings are (plan §9,
 * Days 16–19); refunds, payouts and extra charges by the day they happened.
 */

type Id = Types.ObjectId;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest range one report covers: a little over a year, for a full NZ tax year. */
const MAX_RANGE_DAYS = 400;
/** Booked trips that went, or will go, ahead: what revenue counts. */
const TRIP_STATUSES = ['CONFIRMED', 'ACTIVE', 'COMPLETED'];

export interface ReportRange {
  from: string;
  to: string;
  start: Date;
  /** Exclusive: the start of the day after `to`. */
  end: Date;
}

/** A range of NZ days, checked. */
export function reportRange(from: string, to: string): ReportRange {
  const start = nzDayStart(from);
  const end = new Date(nzDayStart(to).getTime() + DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The end date must be on or after the start date.');
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Choose a range of up to ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to, start, end };
}

const within = ({ start, end }: ReportRange) => mongoose.trusted({ $gte: start, $lt: end });
/** GST included in an amount: 3/23 of it at 15 %. */
const gstIn = (cents: number, ratePct: number) => Math.round((cents * ratePct) / (100 + ratePct));

/** The total of a field over the matching documents. */
const totalOf = (field: string) => [{ $group: { _id: null, total: { $sum: `$${field}` } } }];

/** GET /admin/reports/summary: the figures for a range. */
export async function platformReport(
  from: string,
  to: string,
): Promise<z.infer<typeof platformReportSchema>> {
  const range = reportRange(from, to);
  const settings = await getPlatformSettings();
  const [byStatus, confirmed, completed, cancelled, trips, refunds, payouts, extras, kept] =
    await Promise.all([
      BookingModel.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: range.start, $lt: range.end }, status: { $ne: 'PAYMENT_PENDING' } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      BookingModel.countDocuments({
        statusHistory: mongoose.trusted({
          $elemMatch: { status: 'CONFIRMED', at: { $gte: range.start, $lt: range.end } },
        }),
      }),
      BookingModel.countDocuments({
        statusHistory: mongoose.trusted({
          $elemMatch: { status: 'COMPLETED', at: { $gte: range.start, $lt: range.end } },
        }),
      }),
      BookingModel.countDocuments({ status: 'CANCELLED', cancelledAt: within(range) }),
      BookingModel.aggregate<{ total: number; fees: number; gst: number }>([
        { $match: { startAt: { $gte: range.start, $lt: range.end }, status: { $in: TRIP_STATUSES } } },
        {
          $group: {
            _id: null,
            total: { $sum: '$price.totalCents' },
            fees: { $sum: '$price.platformFeeCents' },
            gst: { $sum: '$price.gstCents' },
          },
        },
      ]),
      PaymentModel.aggregate<{ total: number }>([
        { $unwind: '$refunds' },
        {
          $match: {
            'refunds.createdAt': { $gte: range.start, $lt: range.end },
            'refunds.status': { $ne: 'FAILED' },
          },
        },
        ...totalOf('refunds.amountCents'),
      ]),
      PayoutModel.aggregate<{ total: number }>([
        { $match: { status: 'PAID', paidAt: { $gte: range.start, $lt: range.end } } },
        ...totalOf('amountCents'),
      ]),
      PaymentModel.aggregate<{ total: number }>([
        {
          $match: {
            type: 'EXTRA_CHARGE',
            status: 'SUCCEEDED',
            createdAt: { $gte: range.start, $lt: range.end },
          },
        },
        ...totalOf('amountCents'),
      ]),
      BookingModel.aggregate<{ fees: number; hostShare: number }>([
        { $match: { status: 'CANCELLED', cancelledAt: { $gte: range.start, $lt: range.end } } },
        {
          $group: {
            _id: null,
            fees: { $sum: { $ifNull: ['$cancellationFeeCents', 0] } },
            hostShare: { $sum: { $ifNull: ['$hostShareCents', 0] } },
          },
        },
      ]),
    ]);
  const trip = trips[0] ?? { total: 0, fees: 0, gst: 0 };
  // The platform keeps a kept fee less the Host's share of it.
  const keptFees = (kept[0]?.fees ?? 0) - (kept[0]?.hostShare ?? 0);
  const platformFees = trip.fees + keptFees;
  return {
    from,
    to,
    bookings: {
      created: byStatus.reduce((total, row) => total + row.count, 0),
      confirmed,
      completed,
      cancelled,
      byStatus: Object.fromEntries(byStatus.map((row) => [row._id, row.count])),
    },
    money: {
      grossBookingsCents: trip.total,
      refundsCents: refunds[0]?.total ?? 0,
      platformFeesCents: platformFees,
      hostPayoutsPaidCents: payouts[0]?.total ?? 0,
      extraChargesCents: extras[0]?.total ?? 0,
      cancellationFeesKeptCents: kept[0]?.fees ?? 0,
      gstCollectedCents: trip.gst,
      gstOnPlatformFeesCents: gstIn(platformFees, settings.fees.gstRatePct),
    },
  };
}

// CSV exports -------------------------------------------------------------------------------------------------

const dollars = (cents: number | undefined) => ((cents ?? 0) / 100).toFixed(2);
/** A text cell, quoted when needed, and never read as a spreadsheet formula. */
const text = (value: string | undefined) => {
  const safe = /^[=+\-@\t\r]/.test(value ?? '') ? `'${value}` : (value ?? '');
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const day = (instant: Date | undefined) => (instant ? nzDate(instant) : '');

async function names(ids: Id[]) {
  const people = await UserModel.find({ _id: mongoose.trusted({ $in: ids }) })
    .select('firstName lastName')
    .lean();
  return (id: Id | undefined) => {
    const person = id && people.find((candidate) => candidate._id.equals(id));
    return person ? `${person.firstName} ${person.lastName}` : '';
  };
}

async function refsFor(ids: Id[]) {
  const bookings = await BookingModel.find({ _id: mongoose.trusted({ $in: ids }) })
    .select('ref')
    .lean();
  return (id: Id) => bookings.find((booking) => booking._id.equals(id))?.ref ?? '';
}

type Csv = { header: string[]; rows: string[][] };

async function bookingsCsv(range: ReportRange): Promise<Csv> {
  const bookings = await BookingModel.find({
    startAt: within(range),
    status: mongoose.trusted({ $ne: 'PAYMENT_PENDING' }),
  })
    .sort({ startAt: 1 })
    .lean();
  const name = await names(bookings.flatMap((booking) => [booking.guestId, booking.hostId]));
  return {
    header: [
      'Booking',
      'Status',
      'Booked',
      'Trip start',
      'Trip end',
      'Car',
      'Guest',
      'Host',
      'Rental',
      'Delivery',
      'Service fee',
      'Protection',
      'GST included',
      'Total',
      'Host payout',
      'Platform fees',
    ],
    rows: bookings.map((booking) => [
      booking.ref,
      booking.status,
      day(booking.createdAt),
      day(booking.startAt),
      day(booking.endAt),
      text(booking.vehicleSnapshot.title),
      text(name(booking.guestId)),
      text(name(booking.hostId)),
      dollars(booking.price.subtotalCents),
      dollars(booking.price.deliveryCents),
      dollars(booking.price.serviceFeeCents),
      dollars(booking.price.protectionCents),
      dollars(booking.price.gstCents),
      dollars(booking.price.totalCents),
      dollars(booking.price.hostPayoutCents),
      dollars(booking.price.platformFeeCents),
    ]),
  };
}

async function paymentsCsv(range: ReportRange): Promise<Csv> {
  const payments = await PaymentModel.find({ createdAt: within(range) })
    .sort({ createdAt: 1 })
    .lean();
  const ref = await refsFor(payments.map((payment) => payment.bookingId));
  return {
    header: [
      'Date',
      'Booking',
      'Type',
      'Status',
      'Amount',
      'Refunded',
      'Method',
      'Stripe payment',
      'Failure',
    ],
    rows: payments.map((payment) => [
      day(payment.createdAt),
      ref(payment.bookingId),
      payment.type,
      payment.status,
      dollars(payment.amountCents),
      dollars(
        payment.refunds
          .filter((refund) => refund.status !== 'FAILED')
          .reduce((total, refund) => total + refund.amountCents, 0),
      ),
      text(payment.method),
      payment.stripePaymentIntentId,
      text(payment.failureReason),
    ]),
  };
}

async function refundsCsv(range: ReportRange): Promise<Csv> {
  const payments = await PaymentModel.find({
    refunds: mongoose.trusted({ $elemMatch: { createdAt: { $gte: range.start, $lt: range.end } } }),
  }).lean();
  const ref = await refsFor(payments.map((payment) => payment.bookingId));
  const rows = payments
    .flatMap((payment) =>
      payment.refunds
        .filter((refund) => refund.createdAt >= range.start && refund.createdAt < range.end)
        .map((refund) => ({ payment, refund })),
    )
    .sort((a, b) => a.refund.createdAt.getTime() - b.refund.createdAt.getTime());
  return {
    header: ['Date', 'Booking', 'Amount', 'Funded by', 'Status', 'Reason', 'Stripe refund', 'Failure'],
    rows: rows.map(({ payment, refund }) => [
      day(refund.createdAt),
      ref(payment.bookingId),
      dollars(refund.amountCents),
      refund.fundedBy,
      refund.status,
      text(refund.reason),
      refund.stripeRefundId ?? '',
      text(refund.failureReason),
    ]),
  };
}

async function payoutsCsv(range: ReportRange): Promise<Csv> {
  const payouts = await PayoutModel.find({ scheduledFor: within(range) })
    .sort({ scheduledFor: 1 })
    .lean();
  const [ref, name] = await Promise.all([
    refsFor(payouts.map((payout) => payout.bookingId)),
    names(payouts.map((payout) => payout.hostId)),
  ]);
  return {
    header: [
      'Scheduled',
      'Paid',
      'Booking',
      'Host',
      'Type',
      'Status',
      'Hold',
      'Gross',
      'Commission',
      'GST on commission',
      'Deductions',
      'Paid out',
      'Stripe transfer',
    ],
    rows: payouts.map((payout) => [
      day(payout.scheduledFor),
      day(payout.paidAt),
      ref(payout.bookingId),
      text(name(payout.hostId)),
      payout.type,
      payout.status,
      payout.holdReason ?? '',
      dollars(payout.grossCents),
      dollars(payout.commissionCents),
      dollars(payout.commissionGstCents),
      dollars(payout.deductions.reduce((total, deduction) => total + deduction.amountCents, 0)),
      dollars(payout.amountCents),
      payout.stripeTransferId ?? '',
    ]),
  };
}

async function cancellationsCsv(range: ReportRange): Promise<Csv> {
  const bookings = await BookingModel.find({ status: 'CANCELLED', cancelledAt: within(range) })
    .sort({ cancelledAt: 1 })
    .lean();
  const name = await names(bookings.flatMap((booking) => [booking.guestId, booking.hostId]));
  return {
    header: [
      'Cancelled',
      'Booking',
      'Reason',
      'Trip start',
      'Guest',
      'Host',
      'Total paid',
      'Refunded',
      'Fee kept',
      'Host share',
      'Host cancellation fee',
    ],
    rows: bookings.map((booking) => [
      day(booking.cancelledAt),
      booking.ref,
      booking.cancellationReason ?? '',
      day(booking.startAt),
      text(name(booking.guestId)),
      text(name(booking.hostId)),
      dollars(booking.price.totalCents),
      dollars(booking.refundCents),
      dollars(booking.cancellationFeeCents),
      dollars(booking.hostShareCents),
      dollars(booking.hostCancellationFeeCents),
    ]),
  };
}

/** One row per NZ month: GST in what Guests paid for trips, and in the platform's fees. */
async function gstCsv(range: ReportRange): Promise<Csv> {
  const settings = await getPlatformSettings();
  const months = await BookingModel.aggregate<{ _id: string; total: number; gst: number; fees: number }>([
    { $match: { startAt: { $gte: range.start, $lt: range.end }, status: { $in: TRIP_STATUSES } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$startAt', timezone: 'Pacific/Auckland' } },
        total: { $sum: '$price.totalCents' },
        gst: { $sum: '$price.gstCents' },
        fees: { $sum: '$price.platformFeeCents' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return {
    header: [
      'Month',
      'Trips paid (GST incl.)',
      'GST in trips',
      'Platform fees (GST incl.)',
      'GST in platform fees',
    ],
    rows: months.map((month) => [
      month._id,
      dollars(month.total),
      dollars(month.gst),
      dollars(month.fees),
      dollars(gstIn(month.fees, settings.fees.gstRatePct)),
    ]),
  };
}

const EXPORTS = {
  bookings: bookingsCsv,
  payments: paymentsCsv,
  refunds: refundsCsv,
  payouts: payoutsCsv,
  cancellations: cancellationsCsv,
  gst: gstCsv,
} satisfies Record<z.infer<typeof exportQuerySchema>['type'], (range: ReportRange) => Promise<Csv>>;

/** GET /admin/reports/export: one report as a CSV file. */
export async function exportReport(query: z.infer<typeof exportQuerySchema>) {
  const range = reportRange(query.from, query.to);
  const { header, rows } = await EXPORTS[query.type](range);
  const csv = [header.join(','), ...rows.map((row) => row.join(','))].join('\r\n');
  return { filename: `rento-vroom-${query.type}-${query.from}-to-${query.to}.csv`, csv: `${csv}\r\n` };
}
