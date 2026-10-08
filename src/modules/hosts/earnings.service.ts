import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { addNzDays, fromNzWallClock, startOfNzDay, toNzWallClock } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { keptFeeCommission } from '../bookings/policies.js';
import { PaymentModel } from '../payments/payment.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { UserModel } from '../users/user.model.js';

/*
 * The Host's earnings (spec §9, §23; plan §9 Days 16–19): today, this week, this month against last month,
 * lifetime, a monthly chart, each booking's breakdown and a GST-ready statement. Earnings count on the
 * trip's start date in NZ time, weeks run Monday to Sunday, and amounts are net of Host-funded refunds
 * and Host cancellation fees. A cancelled trip earns the Host's share of any kept fee.
 */

type Id = Types.ObjectId;
type BookingRecord = Booking & { _id: Id };

const EARNING_STATUSES = ['CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
const RENTAL_LINES = ['RENTAL', 'WEEKLY_DISCOUNT', 'MONTHLY_DISCOUNT'];
const DELIVERY_LINES = ['PICKUP_DELIVERY', 'RETURN_DELIVERY'];

export interface EarningsRow {
  ref: string;
  vehicleTitle: string;
  start: string;
  end: string;
  status: Booking['status'];
  rentalCents: number;
  rentalGstCents: number;
  deliveryCents: number;
  deliveryGstCents: number;
  extraChargesCents: number;
  extraChargesGstCents: number;
  /** The Host's share of a fee the Guest didn't get back on cancelling. */
  keptFeeCents: number;
  commissionCents: number;
  commissionGstCents: number;
  hostFundedRefundsCents: number;
  hostCancellationFeeCents: number;
  netCents: number;
}

const gstIn = (cents: number, ratePct: number) => Math.round((cents * ratePct) / (100 + ratePct));
const sumLines = (booking: BookingRecord, codes: string[], field: 'amountCents' | 'gstCents') =>
  booking.lineItems.filter((line) => codes.includes(line.code)).reduce((sum, line) => sum + line[field], 0);

/** One booking's earnings, every amount in NZD cents and GST included. */
function rowFor(
  booking: BookingRecord,
  hostRefunds: number,
  settings: { commissionPct: number; gstPct: number },
): EarningsRow {
  const cancelled = booking.status === 'CANCELLED';
  const extras = booking.extraCharges.filter((charge) => charge.status === 'SUCCEEDED');
  const extrasCents = extras.reduce((sum, charge) => sum + charge.amountCents, 0);
  const extrasCommission = Math.round((extrasCents * settings.commissionPct) / 100);
  const rental = cancelled ? 0 : sumLines(booking, RENTAL_LINES, 'amountCents');
  const delivery = cancelled ? 0 : sumLines(booking, DELIVERY_LINES, 'amountCents');
  const tripCommission = cancelled
    ? keptFeeCommission(booking)
    : booking.price.subtotalCents + booking.price.deliveryCents - booking.price.hostPayoutCents;
  const keptFee = cancelled ? (booking.hostShareCents ?? 0) + tripCommission : 0;
  const commission = tripCommission + extrasCommission;
  const hostFee = booking.hostCancellationFeeCents ?? 0;
  const refunds = cancelled ? 0 : hostRefunds;
  return {
    ref: booking.ref,
    vehicleTitle: booking.vehicleSnapshot.title,
    start: booking.startAt.toISOString(),
    end: booking.endAt.toISOString(),
    status: booking.status,
    rentalCents: rental,
    rentalGstCents: cancelled ? 0 : sumLines(booking, RENTAL_LINES, 'gstCents'),
    deliveryCents: delivery,
    deliveryGstCents: cancelled ? 0 : sumLines(booking, DELIVERY_LINES, 'gstCents'),
    extraChargesCents: extrasCents,
    extraChargesGstCents: gstIn(extrasCents, settings.gstPct),
    keptFeeCents: keptFee,
    commissionCents: commission,
    commissionGstCents: gstIn(commission, settings.gstPct),
    hostFundedRefundsCents: refunds,
    hostCancellationFeeCents: hostFee,
    netCents: rental + delivery + extrasCents + keptFee - commission - refunds - hostFee,
  };
}

/** Every booking that earned the Host something, or cost them a cancellation fee, starting in [from, to). */
async function earningsRows(hostId: string, from?: Date, to?: Date): Promise<EarningsRow[]> {
  const settings = await getPlatformSettings();
  const bookings = await BookingModel.find({
    hostId,
    status: mongoose.trusted({ $in: EARNING_STATUSES }),
    ...((from || to) && {
      startAt: mongoose.trusted({ ...(from && { $gte: from }), ...(to && { $lt: to }) }),
    }),
  })
    .sort({ startAt: -1 })
    .lean<BookingRecord[]>();
  const payments = await PaymentModel.find({
    bookingId: mongoose.trusted({ $in: bookings.map((booking) => booking._id) }),
    type: 'BOOKING',
  })
    .select('bookingId refunds')
    .lean();
  const rates = { commissionPct: settings.fees.hostCommissionPct, gstPct: settings.fees.gstRatePct };
  return bookings
    .map((booking) => {
      const refunds = payments
        .filter((payment) => payment.bookingId.equals(booking._id))
        .flatMap((payment) => payment.refunds)
        .filter((refund) => refund.fundedBy === 'HOST' && refund.status !== 'FAILED')
        .reduce((sum, refund) => sum + refund.amountCents, 0);
      return rowFor(booking, refunds, rates);
    })
    .filter((row) => row.status !== 'CANCELLED' || row.keptFeeCents > 0 || row.hostCancellationFeeCents > 0);
}

/** Monday 00:00 NZ time of the week an instant falls in. */
function startOfNzWeek(instant: Date): Date {
  const { weekday } = toNzWallClock(instant);
  return startOfNzDay(addNzDays(instant, -((weekday + 6) % 7)));
}

function startOfNzMonth(year: number, month: number): Date {
  return fromNzWallClock(year, month, 1);
}

const monthKey = (instant: Date) => {
  const { year, month } = toNzWallClock(instant);
  return `${year}-${String(month).padStart(2, '0')}`;
};

const total = (rows: EarningsRow[], from: Date, to: Date) =>
  rows
    .filter((row) => new Date(row.start) >= from && new Date(row.start) < to)
    .reduce((sum, row) => sum + row.netCents, 0);

/** GET /host/earnings: the dashboard's figures, the last 12 months and this month's bookings. */
export async function hostEarnings(hostId: string, now = new Date()) {
  const host = await UserModel.findById(hostId).select('hostProfile').lean();
  if (!host?.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  const rows = await earningsRows(hostId);
  const { year, month } = toNzWallClock(now);
  const today = startOfNzDay(now);
  const week = startOfNzWeek(now);
  const thisMonth = startOfNzMonth(year, month);
  const nextMonth = month === 12 ? startOfNzMonth(year + 1, 1) : startOfNzMonth(year, month + 1);
  const lastMonth = month === 1 ? startOfNzMonth(year - 1, 12) : startOfNzMonth(year, month - 1);
  const far = new Date(8.64e15);

  const months: { month: string; netCents: number }[] = [];
  for (let back = 11; back >= 0; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    const start = startOfNzMonth(Math.floor(index / 12), (index % 12) + 1);
    const endIndex = index + 1;
    const end = startOfNzMonth(Math.floor(endIndex / 12), (endIndex % 12) + 1);
    months.push({ month: monthKey(start), netCents: total(rows, start, end) });
  }

  const upcoming = await PayoutModel.aggregate<{ total: number }>([
    {
      $match: {
        hostId: new mongoose.Types.ObjectId(hostId),
        status: { $in: ['SCHEDULED', 'HELD', 'FAILED'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$amountCents' } } },
  ]);
  const monthRows = rows.filter((row) => new Date(row.start) >= thisMonth && new Date(row.start) < nextMonth);

  return {
    summary: {
      todayCents: total(rows, today, addNzDays(today, 1)),
      weekCents: total(rows, week, addNzDays(week, 7)),
      monthCents: total(rows, thisMonth, nextMonth),
      previousMonthCents: total(rows, lastMonth, thisMonth),
      lifetimeCents: total(rows, new Date(0), far),
      upcomingPayoutsCents: upcoming[0]?.total ?? 0,
      platformFeesMonthCents: monthRows.reduce((sum, row) => sum + row.commissionCents, 0),
      platformFeesLifetimeCents: rows.reduce((sum, row) => sum + row.commissionCents, 0),
    },
    months,
    bookings: rows.slice(0, 100),
    gstRegistered: host.hostProfile.gstRegistered,
  };
}

/** The NZ dates a statement covers: a month ("2026-10") or a tax year ending 31 March ("2027"). */
export function statementPeriod(period: string): { from: Date; to: Date; label: string } {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const year = Number(month[1]);
    const index = Number(month[2]);
    if (index < 1 || index > 12) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a month.');
    return {
      from: startOfNzMonth(year, index),
      to: index === 12 ? startOfNzMonth(year + 1, 1) : startOfNzMonth(year, index + 1),
      label: period,
    };
  }
  const taxYear = /^(\d{4})$/.exec(period);
  if (taxYear) {
    const ending = Number(taxYear[1]);
    return {
      from: startOfNzMonth(ending - 1, 4),
      to: startOfNzMonth(ending, 4),
      label: `tax-year-${ending - 1}-${String(ending).slice(2)}`,
    };
  }
  throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a month (2026-10) or a tax year (2027).');
}

const dollars = (cents: number) => (cents / 100).toFixed(2);
const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * GET /host/earnings/statement: a CSV for the Host's records and tax return (spec §23), one row per
 * booking with rental, delivery, extra charges, platform commission, deductions and GST separately, and a
 * total row. For a GST-registered Host, the commission and its GST can be used as a tax invoice once the
 * accountant confirms its form (plan §8.1, item 22).
 */
export async function earningsStatement(
  hostId: string,
  period: string,
): Promise<{ filename: string; csv: string }> {
  const { from, to, label } = statementPeriod(period);
  const host = await UserModel.findById(hostId).select('firstName lastName hostProfile').lean();
  if (!host?.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  const rows = (await earningsRows(hostId, from, to)).reverse();
  const header = [
    'Trip start (NZ)',
    'Booking',
    'Car',
    'Status',
    'Rental',
    'GST in rental',
    'Delivery',
    'GST in delivery',
    'Extra charges',
    'GST in extra charges',
    'Kept cancellation fee',
    'Platform commission',
    'GST in commission',
    'Host-funded refunds',
    'Host cancellation fee',
    'Net earnings',
  ];
  const nzDay = (iso: string) => {
    const { year, month, day } = toNzWallClock(new Date(iso));
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  };
  const money: (keyof EarningsRow)[] = [
    'rentalCents',
    'rentalGstCents',
    'deliveryCents',
    'deliveryGstCents',
    'extraChargesCents',
    'extraChargesGstCents',
    'keptFeeCents',
    'commissionCents',
    'commissionGstCents',
    'hostFundedRefundsCents',
    'hostCancellationFeeCents',
    'netCents',
  ];
  const lines = rows.map((row) =>
    [
      nzDay(row.start),
      row.ref,
      row.vehicleTitle,
      row.status,
      ...money.map((key) => dollars(row[key] as number)),
    ]
      .map(csvCell)
      .join(','),
  );
  const totals = money.map((key) => dollars(rows.reduce((sum, row) => sum + (row[key] as number), 0)));
  const preface = [
    `Rento Vroom earnings statement,${csvCell(`${host.firstName} ${host.lastName}`)}`,
    `Period,${label}`,
    ...(host.hostProfile.gstRegistered && host.hostProfile.gstNumber
      ? [`GST number,${csvCell(host.hostProfile.gstNumber)}`]
      : []),
    'All amounts in NZD and include GST',
    '',
  ];
  const csv = [...preface, header.join(','), ...lines, ['Total', '', '', '', ...totals].join(',')].join(
    '\r\n',
  );
  return { filename: `rento-vroom-earnings-${label}.csv`, csv: `${csv}\r\n` };
}
