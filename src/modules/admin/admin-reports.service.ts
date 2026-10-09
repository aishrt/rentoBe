import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { NZ_TIME_ZONE, nzDate } from '../../lib/nz-time.js';
import { BookingModel } from '../bookings/booking.model.js';
import { PaymentModel, type Refund } from '../payments/payment.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { UserModel } from '../users/user.model.js';
import type { exportQuerySchema, platformReportSchema } from './admin-ops.schemas.js';
import { nzDayStart } from './admin-bookings.service.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Platform reports (spec §18; plan §9 Days 19–23), admin only: bookings, revenue, fees, payouts,
 * cancellations and a GST summary for a range of NZ days, built with MongoDB aggregations, and each as a
 * CSV download. Money on trips is counted by the trip's start date, as the Hosts' earnings are (plan §9,
 * Days 16–19); cancellation fees by the day of the cancellation; refunds, payouts and extra charges by the
 * day they happened. The summary, the revenue and fees export and the GST export are all added up from the
 * same figures for each NZ day, so their totals agree for the same dates.
 */

type Id = Types.ObjectId;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest range one report covers: a little over a year, for a full NZ tax year. */
const MAX_RANGE_DAYS = 400;
/** Booked trips that went, or will go, ahead: what revenue counts. */
const TRIP_STATUSES = ['CONFIRMED', 'ACTIVE', 'COMPLETED'];
/** Extra charges the Guest paid; any refund of one is counted with the refunds. */
const PAID_EXTRA_CHARGE = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
/*
 * Refunds of money this report never counts: a cancellation's own refund, since the fee kept is what's left
 * after it, and the refund of a payment that came in after its booking had ended. Each refund says which it is
 * (`kind`); ones recorded before that field existed are recognised by the reason that bookings/booking.service.ts
 * and jobs/handlers/booking-jobs.ts wrote then.
 */
const CANCELLATION_REFUND = /^Cancellation \(/;
const LATE_PAYMENT_REFUND = 'Paid after the booking had ended';

function uncountedRefund(refund: Pick<Refund, 'kind' | 'reason'>) {
  if (refund.kind) return refund.kind === 'CANCELLATION' || refund.kind === 'LATE_PAYMENT';
  const reason = refund.reason ?? '';
  return CANCELLATION_REFUND.test(reason) || reason === LATE_PAYMENT_REFUND;
}

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
/** The NZ date of a date field, as YYYY-MM-DD, in an aggregation. */
const nzDayOf = (field: string) => ({
  $dateToString: { format: '%Y-%m-%d', date: field, timezone: NZ_TIME_ZONE },
});

/** One NZ day's money, in cents: what the summary and the money exports add up. */
interface DayFigures {
  trips: number;
  /** Paid for trips starting that day, GST included. */
  tripsCents: number;
  serviceFeesCents: number;
  hostCommissionCents: number;
  /** Kept from bookings cancelled that day, GST included. */
  keptFeesCents: number;
  /** The platform's part of those: the fee less the Host's share. */
  cancellationShareCents: number;
  extraChargesCents: number;
  extraCommissionCents: number;
  /** Service fees, commission, the share of fees kept and the commission on extra charges. */
  platformFeesCents: number;
  refundsCents: number;
  platformRefundsCents: number;
  /** Refunds of money counted here (trips, extra charges and fees kept), whose GST is given back. */
  givenBackCents: number;
  gstInTripsCents: number;
  gstInExtraChargesCents: number;
  gstInCancellationFeesCents: number;
  gstGivenBackCents: number;
  /** Trips, extra charges and fees kept, less refunds. */
  gstCollectedCents: number;
  gstOnPlatformFeesCents: number;
}

const emptyDay = (): DayFigures => ({
  trips: 0,
  tripsCents: 0,
  serviceFeesCents: 0,
  hostCommissionCents: 0,
  keptFeesCents: 0,
  cancellationShareCents: 0,
  extraChargesCents: 0,
  extraCommissionCents: 0,
  platformFeesCents: 0,
  refundsCents: 0,
  platformRefundsCents: 0,
  givenBackCents: 0,
  gstInTripsCents: 0,
  gstInExtraChargesCents: 0,
  gstInCancellationFeesCents: 0,
  gstGivenBackCents: 0,
  gstCollectedCents: 0,
  gstOnPlatformFeesCents: 0,
});

function sumOf(days: DayFigures[]): DayFigures {
  const sum = emptyDay();
  for (const day of days) {
    for (const key of Object.keys(sum) as (keyof DayFigures)[]) sum[key] += day[key];
  }
  return sum;
}

/** Whether a refund gives back money this report counts, and with it the GST in it. */
function givesBackCounted(
  paymentType: string,
  bookingStatus: string | undefined,
  refund: Pick<Refund, 'kind' | 'reason'>,
) {
  if (paymentType === 'EXTRA_CHARGE') return true;
  if (bookingStatus && TRIP_STATUSES.includes(bookingStatus)) return true;
  // A cancelled booking counts the fee kept: a later refund gives part of it back.
  return bookingStatus === 'CANCELLED' && !uncountedRefund(refund);
}

/** Extra charges paid in the range, with the commission the platform kept on each (plan §5). */
async function extraCharges(range: ReportRange, commissionPct: number) {
  const payments = await PaymentModel.find({
    type: 'EXTRA_CHARGE',
    status: mongoose.trusted({ $in: PAID_EXTRA_CHARGE }),
    createdAt: within(range),
  })
    .select('extraChargeId amountCents createdAt')
    .lean();
  const payouts = await PayoutModel.find({
    type: 'EXTRA_CHARGE',
    extraChargeId: mongoose.trusted({
      $in: payments.flatMap((payment) => (payment.extraChargeId ? [payment.extraChargeId] : [])),
    }),
  })
    .select('extraChargeId commissionCents')
    .lean();
  const commissions = new Map(
    payouts.map((payout) => [payout.extraChargeId?.toString(), payout.commissionCents]),
  );
  return payments.map((payment) => ({
    day: nzDate(payment.createdAt),
    amountCents: payment.amountCents,
    // The payout records the commission taken; one not made yet takes it at today's rate.
    commissionCents:
      commissions.get(payment.extraChargeId?.toString()) ??
      Math.round((payment.amountCents * commissionPct) / 100),
  }));
}

/** Refunds sent in the range (failed ones aside), who funded each, and whether it gives back counted money. */
async function refundsSent(range: ReportRange) {
  const payments = await PaymentModel.find({
    refunds: mongoose.trusted({ $elemMatch: { createdAt: { $gte: range.start, $lt: range.end } } }),
  })
    .select('bookingId type refunds')
    .lean();
  const bookings = await BookingModel.find({
    _id: mongoose.trusted({ $in: payments.map((payment) => payment.bookingId) }),
  })
    .select('status')
    .lean();
  return payments.flatMap((payment) => {
    const status = bookings.find((booking) => booking._id.equals(payment.bookingId))?.status;
    return (payment.refunds ?? [])
      .filter(
        (refund) =>
          refund.status !== 'FAILED' && refund.createdAt >= range.start && refund.createdAt < range.end,
      )
      .map((refund) => ({
        day: nzDate(refund.createdAt),
        amountCents: refund.amountCents,
        platformFunded: refund.fundedBy === 'PLATFORM',
        givenBack: givesBackCounted(payment.type, status, refund),
      }));
  });
}

/**
 * The money of each NZ day in the range that had any, in date order: trips by their start date, fees kept
 * by the day of the cancellation, extra charges and refunds by the day they were made. GST is worked out
 * for each day at the rate in settings (plan §5: included in every price, 3/23 at 15 %, provisional).
 */
async function dailyFigures(range: ReportRange): Promise<[string, DayFigures][]> {
  const settings = await getPlatformSettings();
  const rate = settings.fees.gstRatePct;
  const [trips, cancellations, charges, refunds] = await Promise.all([
    BookingModel.aggregate<{
      _id: string;
      trips: number;
      total: number;
      gst: number;
      serviceFees: number;
      platformFees: number;
    }>([
      { $match: { startAt: { $gte: range.start, $lt: range.end }, status: { $in: TRIP_STATUSES } } },
      {
        $group: {
          _id: nzDayOf('$startAt'),
          trips: { $sum: 1 },
          total: { $sum: '$price.totalCents' },
          gst: { $sum: '$price.gstCents' },
          serviceFees: { $sum: '$price.serviceFeeCents' },
          platformFees: { $sum: '$price.platformFeeCents' },
        },
      },
    ]),
    BookingModel.aggregate<{ _id: string; fees: number; hostShare: number }>([
      { $match: { status: 'CANCELLED', cancelledAt: { $gte: range.start, $lt: range.end } } },
      {
        $group: {
          _id: nzDayOf('$cancelledAt'),
          fees: { $sum: { $ifNull: ['$cancellationFeeCents', 0] } },
          hostShare: { $sum: { $ifNull: ['$hostShareCents', 0] } },
        },
      },
    ]),
    extraCharges(range, settings.fees.hostCommissionPct),
    refundsSent(range),
  ]);

  const days = new Map<string, DayFigures>();
  const on = (day: string) => {
    const figures = days.get(day) ?? emptyDay();
    days.set(day, figures);
    return figures;
  };
  for (const row of trips) {
    const day = on(row._id);
    day.trips += row.trips;
    day.tripsCents += row.total;
    day.gstInTripsCents += row.gst;
    day.serviceFeesCents += row.serviceFees;
    // The platform fee is the service fee plus the commission on the Host's rental (plan §5).
    day.hostCommissionCents += row.platformFees - row.serviceFees;
  }
  for (const row of cancellations) {
    const day = on(row._id);
    day.keptFeesCents += row.fees;
    // The platform keeps a kept fee less the Host's share of it.
    day.cancellationShareCents += row.fees - row.hostShare;
  }
  for (const charge of charges) {
    const day = on(charge.day);
    day.extraChargesCents += charge.amountCents;
    day.extraCommissionCents += charge.commissionCents;
  }
  for (const refund of refunds) {
    const day = on(refund.day);
    day.refundsCents += refund.amountCents;
    if (refund.platformFunded) day.platformRefundsCents += refund.amountCents;
    if (refund.givenBack) day.givenBackCents += refund.amountCents;
  }
  for (const day of days.values()) {
    day.platformFeesCents =
      day.serviceFeesCents + day.hostCommissionCents + day.cancellationShareCents + day.extraCommissionCents;
    day.gstInExtraChargesCents = gstIn(day.extraChargesCents, rate);
    day.gstInCancellationFeesCents = gstIn(day.keptFeesCents, rate);
    day.gstGivenBackCents = gstIn(day.givenBackCents, rate);
    day.gstCollectedCents =
      day.gstInTripsCents +
      day.gstInExtraChargesCents +
      day.gstInCancellationFeesCents -
      day.gstGivenBackCents;
    day.gstOnPlatformFeesCents = gstIn(day.platformFeesCents, rate);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The money in a range as the reports count it, for the overview (spec §18): what Guests paid for trips,
 * extra charges and kept fees, less the refunds of that money (a cancellation's own refund is already out of
 * the fee kept, and a late payment's was never counted), and the platform's fees.
 */
export async function rangeMoney(range: ReportRange) {
  const sum = sumOf((await dailyFigures(range)).map(([, figures]) => figures));
  return {
    bookingRevenueCents: sum.tripsCents + sum.extraChargesCents + sum.keptFeesCents - sum.givenBackCents,
    platformFeesCents: sum.platformFeesCents,
  };
}

/** GET /admin/reports/summary: the figures for a range. */
export async function platformReport(
  from: string,
  to: string,
): Promise<z.infer<typeof platformReportSchema>> {
  const range = reportRange(from, to);
  const [settings, byStatus, confirmed, completed, cancelled, payouts, days] = await Promise.all([
    getPlatformSettings(),
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
    PayoutModel.aggregate<{ total: number }>([
      { $match: { status: 'PAID', paidAt: { $gte: range.start, $lt: range.end } } },
      ...totalOf('amountCents'),
    ]),
    dailyFigures(range),
  ]);
  const sum = sumOf(days.map(([, figures]) => figures));
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
      grossBookingsCents: sum.tripsCents,
      refundsCents: sum.refundsCents,
      platformFeesCents: sum.platformFeesCents,
      hostPayoutsPaidCents: payouts[0]?.total ?? 0,
      extraChargesCents: sum.extraChargesCents,
      cancellationFeesKeptCents: sum.keptFeesCents,
      gstCollectedCents: sum.gstCollectedCents,
      gstOnPlatformFeesCents: sum.gstOnPlatformFeesCents,
    },
    fees: {
      serviceFeesCents: sum.serviceFeesCents,
      hostCommissionCents: sum.hostCommissionCents,
      cancellationFeesShareCents: sum.cancellationShareCents,
      extraChargeCommissionCents: sum.extraCommissionCents,
      totalCents: sum.platformFeesCents,
    },
    gst: {
      ratePct: settings.fees.gstRatePct,
      inTripsCents: sum.gstInTripsCents,
      inExtraChargesCents: sum.gstInExtraChargesCents,
      inCancellationFeesCents: sum.gstInCancellationFeesCents,
      givenBackCents: sum.gstGivenBackCents,
      collectedCents: sum.gstCollectedCents,
      onPlatformFeesCents: sum.gstOnPlatformFeesCents,
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

/**
 * One row per NZ month, and the total: GST in what Guests paid for trips, extra charges and the fees kept
 * when they cancelled, less the GST in refunds of that money; and the GST in the platform's fees.
 */
async function gstCsv(range: ReportRange): Promise<Csv> {
  const months = new Map<string, DayFigures[]>();
  for (const [day, figures] of await dailyFigures(range)) {
    const month = day.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), figures]);
  }
  const row = (label: string, figures: DayFigures) => [
    text(label),
    dollars(figures.tripsCents),
    dollars(figures.gstInTripsCents),
    dollars(figures.extraChargesCents),
    dollars(figures.gstInExtraChargesCents),
    dollars(figures.keptFeesCents),
    dollars(figures.gstInCancellationFeesCents),
    dollars(figures.givenBackCents),
    dollars(figures.gstGivenBackCents),
    dollars(figures.gstCollectedCents),
    dollars(figures.platformFeesCents),
    dollars(figures.gstOnPlatformFeesCents),
  ];
  const rows = [...months.entries()].map(([month, days]) => row(month, sumOf(days)));
  return {
    header: [
      'Month',
      'Trips paid (GST incl.)',
      'GST in trips',
      'Extra charges (GST incl.)',
      'GST in extra charges',
      'Cancellation fees kept (GST incl.)',
      'GST in cancellation fees',
      'Refunds of these (GST incl.)',
      'GST given back',
      'GST collected',
      'Platform fees (GST incl.)',
      'GST in platform fees',
    ],
    rows: [...rows, row('Total', sumOf([...months.values()].flat()))],
  };
}

/**
 * One row per NZ day with money, and the total: what Guests paid for trips, the platform's fees by kind,
 * extra charges, and refunds. The totals match the summary for the same dates.
 */
async function revenueCsv(range: ReportRange): Promise<Csv> {
  const days = await dailyFigures(range);
  const row = (label: string, figures: DayFigures) => [
    text(label),
    String(figures.trips),
    dollars(figures.tripsCents),
    dollars(figures.serviceFeesCents),
    dollars(figures.hostCommissionCents),
    dollars(figures.keptFeesCents),
    dollars(figures.cancellationShareCents),
    dollars(figures.extraChargesCents),
    dollars(figures.extraCommissionCents),
    dollars(figures.platformFeesCents),
    dollars(figures.gstOnPlatformFeesCents),
    dollars(figures.refundsCents),
    dollars(figures.platformRefundsCents),
  ];
  return {
    header: [
      'Date',
      'Trips starting',
      'Booking revenue (GST incl.)',
      'Service fees',
      'Host commission',
      'Cancellation fees kept',
      'Platform share of cancellation fees',
      'Extra charges',
      'Extra-charge commission',
      'Platform fees',
      'GST in platform fees',
      'Refunds',
      'Refunds funded by the platform',
    ],
    rows: [
      ...days.map(([day, figures]) => row(day, figures)),
      row('Total', sumOf(days.map(([, figures]) => figures))),
    ],
  };
}

const EXPORTS = {
  bookings: bookingsCsv,
  payments: paymentsCsv,
  refunds: refundsCsv,
  payouts: payoutsCsv,
  cancellations: cancellationsCsv,
  gst: gstCsv,
  revenue: revenueCsv,
} satisfies Record<z.infer<typeof exportQuerySchema>['type'], (range: ReportRange) => Promise<Csv>>;

/** GET /admin/reports/export: one report as a CSV file. */
export async function exportReport(query: z.infer<typeof exportQuerySchema>) {
  const range = reportRange(query.from, query.to);
  const { header, rows } = await EXPORTS[query.type](range);
  const csv = [header.join(','), ...rows.map((row) => row.join(','))].join('\r\n');
  return { filename: `rento-vroom-${query.type}-${query.from}-to-${query.to}.csv`, csv: `${csv}\r\n` };
}
