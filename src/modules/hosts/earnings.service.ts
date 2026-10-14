import mongoose, { type Types } from 'mongoose';
import { CSV_BOM, csvText } from '../../lib/csv.js';
import { HttpError } from '../../lib/http-error.js';
import { addNzDays, fromNzWallClock, startOfNzDay, toNzWallClock } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { keptFeeCommission } from '../bookings/policies.js';
import { PaymentModel, type Payment } from '../payments/payment.model.js';
import { PayoutModel, type Payout } from '../payouts/payout.model.js';
import { gstIn, hostPartOf, reservedCents } from '../payouts/payouts.service.js';
import { UserModel, type HostProfile } from '../users/user.model.js';

/*
 * The Host's earnings (spec §9, §23; plan §9 Days 16–19): today, this week, this month against last month,
 * lifetime, a monthly chart, each booking's breakdown and a GST-ready statement. Earnings count on the
 * trip's start date in NZ time, weeks run Monday to Sunday, and amounts are net of Host-funded refunds (the
 * Host's share of each, of the booking and its extra charges) and Host cancellation fees. A cancelled trip
 * earns the Host's share of any kept fee.
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

const sumLines = (booking: BookingRecord, codes: string[], field: 'amountCents' | 'gstCents') =>
  booking.lineItems.filter((line) => codes.includes(line.code)).reduce((sum, line) => sum + line[field], 0);

export type PayoutPart = Pick<Payout, 'type' | 'extraChargeId' | 'commissionCents' | 'commissionGstCents'>;

/**
 * One booking's earnings, every amount in NZD cents and GST included. Each part's commission and its GST are
 * the ones its payout was made with (the trip's or the kept fee's, and each extra charge's), so the statement
 * matches the payouts (plan §8.1, item 22); a part without a payout yet is worked out at today's rates, its GST
 * rounded on its own as its payout's will be.
 */
function rowFor(
  booking: BookingRecord,
  { all: hostRefunds, staff: hostStaffRefunds }: { all: number; staff: number },
  payouts: PayoutPart[],
  settings: { commissionPct: number; gstPct: number },
): EarningsRow {
  const cancelled = booking.status === 'CANCELLED';
  const part = (payout: PayoutPart | undefined, commission: number) => {
    const cents = payout?.commissionCents ?? commission;
    return { cents, gstCents: payout?.commissionGstCents ?? gstIn(cents, settings.gstPct) };
  };
  const extras = booking.extraCharges.filter((charge) => charge.status === 'SUCCEEDED');
  const extrasCents = extras.reduce((sum, charge) => sum + charge.amountCents, 0);
  const extraParts = extras.map((charge) =>
    part(
      payouts.find((payout) => payout.type === 'EXTRA_CHARGE' && payout.extraChargeId?.equals(charge._id!)),
      Math.round((charge.amountCents * settings.commissionPct) / 100),
    ),
  );
  const rental = cancelled ? 0 : sumLines(booking, RENTAL_LINES, 'amountCents');
  const delivery = cancelled ? 0 : sumLines(booking, DELIVERY_LINES, 'amountCents');
  const trip = part(
    payouts.find((payout) => payout.type === (cancelled ? 'CANCELLATION_FEE' : 'TRIP')),
    cancelled
      ? keptFeeCommission(booking)
      : booking.price.subtotalCents + booking.price.deliveryCents - booking.price.hostPayoutCents,
  );
  const keptFee = cancelled ? (booking.hostShareCents ?? 0) + trip.cents : 0;
  const commission = trip.cents + extraParts.reduce((sum, extra) => sum + extra.cents, 0);
  const commissionGst = trip.gstCents + extraParts.reduce((sum, extra) => sum + extra.gstCents, 0);
  // Less any part an admin waived (plan §8.1, item 10).
  const hostFee = Math.max(
    0,
    (booking.hostCancellationFeeCents ?? 0) - (booking.hostCancellationFeeWaivedCents ?? 0),
  );
  // A cancelled booking's cancellation refund is already out of its kept fee; a Host-funded refund staff made
  // after it (of the booking or an extra charge) still comes off the Host's payouts, so it counts here too.
  const refunds = cancelled ? hostStaffRefunds : hostRefunds;
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
    commissionGstCents: commissionGst,
    hostFundedRefundsCents: refunds,
    hostCancellationFeeCents: hostFee,
    netCents: rental + delivery + extrasCents + keptFee - commission - refunds - hostFee,
  };
}

/**
 * One booking's earnings row, from its payments (the booking's own and its extra charges', for their
 * Host-funded refunds) and its payouts not cancelled. The earnings page, the statement and the Host's booking
 * page all count a booking this way.
 */
export function bookingEarnings(
  booking: BookingRecord,
  payments: Pick<Payment, 'type' | 'refunds'>[],
  payouts: PayoutPart[],
  rates: { commissionPct: number; gstPct: number },
): EarningsRow {
  const hostFunded = payments.flatMap((payment) =>
    payment.refunds
      .filter((refund) => refund.fundedBy === 'HOST' && refund.status !== 'FAILED')
      .map((refund) => ({ refund, extraCharge: payment.type === 'EXTRA_CHARGE' })),
  );
  // What the Host pays back for each: their share of it.
  const sum = (refunds: typeof hostFunded) =>
    refunds.reduce((total, { refund }) => total + hostPartOf(refund), 0);
  return rowFor(
    booking,
    {
      all: sum(hostFunded),
      staff: sum(hostFunded.filter(({ refund, extraCharge }) => extraCharge || refund.kind === 'STAFF')),
    },
    payouts,
    rates,
  );
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
  const ids = mongoose.trusted({ $in: bookings.map((booking) => booking._id) });
  // The booking's own payment and its extra charges' (plan §8.1, items 11 and 15).
  const [payments, payouts] = await Promise.all([
    PaymentModel.find({ bookingId: ids }).select('bookingId type refunds').lean(),
    PayoutModel.find({ bookingId: ids, status: mongoose.trusted({ $ne: 'CANCELLED' }) })
      .select('bookingId type extraChargeId commissionCents commissionGstCents')
      .lean(),
  ]);
  const rates = { commissionPct: settings.fees.hostCommissionPct, gstPct: settings.fees.gstRatePct };
  return (
    bookings
      .map((booking) =>
        bookingEarnings(
          booking,
          payments.filter((payment) => payment.bookingId.equals(booking._id)),
          payouts.filter((payout) => payout.bookingId.equals(booking._id)),
          rates,
        ),
      )
      // A cancelled booking shows while any line on it isn't zero (a kept fee, a refund, a fee or extra charges).
      .filter(
        (row) =>
          row.status !== 'CANCELLED' ||
          [
            row.keptFeeCents,
            row.extraChargesCents,
            row.commissionCents,
            row.hostFundedRefundsCents,
            row.hostCancellationFeeCents,
            row.netCents,
          ].some((cents) => cents !== 0),
      )
  );
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

/** Trips in the per-booking breakdown when no month is asked for. */
const LATEST_TRIPS = 100;

/**
 * What the Host's payouts still to be sent will bring, as they're sent (plan §8.1, items 10 and 15): each less
 * the deductions already reserved for it or, not reserved yet, less the Host-funded refunds of its own booking
 * or charge and then the Host cancellation fees and refunds the Host owes, soonest payout first, never below
 * zero. Anything owed beyond them stays owed.
 */
async function upcomingPayoutsNet(hostId: string, profile: Partial<HostProfile>): Promise<number> {
  const upcoming = await PayoutModel.find({
    hostId,
    status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }),
  })
    .sort({ scheduledFor: 1, _id: 1 })
    .select('type bookingId extraChargeId amountCents deductions deductionsReservedAt')
    .lean();
  const fresh = upcoming.filter(
    (payout) => !payout.deductionsReservedAt && (payout.type === 'TRIP' || payout.type === 'EXTRA_CHARGE'),
  );
  const payments =
    fresh.length > 0
      ? await PaymentModel.find({
          bookingId: mongoose.trusted({ $in: fresh.map((payout) => payout.bookingId) }),
        })
          .select('bookingId type extraChargeId refunds')
          .lean()
      : [];
  let owed =
    (profile.feesOwedCents ?? 0) +
    (profile.refundsOwed ?? []).reduce((sum, refund) => sum + refund.amountCents, 0);
  let net = 0;
  for (const payout of upcoming) {
    if (payout.deductionsReservedAt) {
      net += Math.max(0, payout.amountCents - reservedCents(payout));
      continue;
    }
    // A trip's payout first takes the refunds of the booking's payment; an extra charge's, those of that charge.
    const own =
      payout.type === 'CANCELLATION_FEE'
        ? 0
        : payments
            .filter(
              (payment) =>
                payment.bookingId.equals(payout.bookingId) &&
                (payout.type === 'TRIP'
                  ? payment.type === 'BOOKING'
                  : payment.type === 'EXTRA_CHARGE' &&
                    Boolean(payment.extraChargeId?.equals(payout.extraChargeId!))),
            )
            .flatMap((payment) => payment.refunds)
            .filter((refund) => refund.fundedBy === 'HOST' && refund.status !== 'FAILED')
            .reduce((sum, refund) => sum + hostPartOf(refund), 0);
    const left = Math.max(0, payout.amountCents - own);
    const taken = Math.min(left, owed);
    owed -= taken;
    net += left - taken;
  }
  return net;
}

/**
 * GET /host/earnings: the dashboard's figures, the last 12 months, and each trip's breakdown: those starting in
 * `month` ("2026-10"), or the latest 100 when none is asked for.
 */
export async function hostEarnings(hostId: string, now = new Date(), month?: string) {
  const host = await UserModel.findById(hostId).select('hostProfile').lean();
  if (!host?.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  const rows = await earningsRows(hostId);
  const nz = toNzWallClock(now);
  const today = startOfNzDay(now);
  const week = startOfNzWeek(now);
  const thisMonth = startOfNzMonth(nz.year, nz.month);
  const nextMonth = nz.month === 12 ? startOfNzMonth(nz.year + 1, 1) : startOfNzMonth(nz.year, nz.month + 1);
  const lastMonth = nz.month === 1 ? startOfNzMonth(nz.year - 1, 12) : startOfNzMonth(nz.year, nz.month - 1);

  const months: { month: string; netCents: number }[] = [];
  for (let back = 11; back >= 0; back -= 1) {
    const index = nz.year * 12 + (nz.month - 1) - back;
    const start = startOfNzMonth(Math.floor(index / 12), (index % 12) + 1);
    const endIndex = index + 1;
    const end = startOfNzMonth(Math.floor(endIndex / 12), (endIndex % 12) + 1);
    months.push({ month: monthKey(start), netCents: total(rows, start, end) });
  }

  const monthRows = rows.filter((row) => new Date(row.start) >= thisMonth && new Date(row.start) < nextMonth);
  // Lifetime runs to the end of this month, like the chart: a trip booked for next year isn't earned yet.
  const toDate = rows.filter((row) => new Date(row.start) < nextMonth);
  const asked = month ? statementPeriod(month) : null;
  const settings = await getPlatformSettings();

  return {
    summary: {
      todayCents: total(rows, today, addNzDays(today, 1)),
      weekCents: total(rows, week, addNzDays(week, 7)),
      monthCents: total(rows, thisMonth, nextMonth),
      previousMonthCents: total(rows, lastMonth, thisMonth),
      lifetimeCents: total(toDate, new Date(0), nextMonth),
      upcomingPayoutsCents: await upcomingPayoutsNet(hostId, host.hostProfile),
      platformFeesMonthCents: monthRows.reduce((sum, row) => sum + row.commissionCents, 0),
      platformFeesLifetimeCents: toDate.reduce((sum, row) => sum + row.commissionCents, 0),
    },
    months,
    bookings: asked
      ? rows.filter((row) => new Date(row.start) >= asked.from && new Date(row.start) < asked.to)
      : rows.slice(0, LATEST_TRIPS),
    // Every month with a trip, newest first, for choosing one: a month beyond the latest 100 is asked for.
    tripMonths: [...new Set(rows.map((row) => monthKey(new Date(row.start))))],
    gstRegistered: host.hostProfile.gstRegistered,
    // Who charges the commission, for a GST-registered Host's tax invoice (plan §8.1, item 22).
    ...(host.hostProfile.gstRegistered && { supplier: supplierOf(settings.business) }),
  };
}

/** Rento Vroom as the supplier of its commission: its legal name, and its GST number once it has one. */
const supplierOf = (business: { legalName: string; gstNumber?: string }) => ({
  name: business.legalName,
  ...(business.gstNumber && { gstNumber: business.gstNumber }),
});

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

/**
 * GET /host/earnings/statement: a CSV for the Host's records and tax return (spec §23), one row per
 * booking with rental, delivery, extra charges, kept fees, platform commission and deductions, each with the
 * GST in it, and a total row. For a GST-registered Host, the commission and its GST can be used as a tax
 * invoice once the accountant confirms its form (plan §8.1, item 22): the preface names Rento Vroom as the
 * supplier, with its GST number once it has one. Like the staff reports, it starts with a byte order mark so
 * Excel shows macrons as they are, and no text cell can be read as a formula.
 */
export async function earningsStatement(
  hostId: string,
  period: string,
): Promise<{ filename: string; csv: string }> {
  const { from, to, label } = statementPeriod(period);
  const host = await UserModel.findById(hostId).select('firstName lastName hostProfile').lean();
  if (!host?.hostProfile) throw new HttpError(404, 'NOT_A_HOST', "You haven't applied to host yet.");
  const rows = (await earningsRows(hostId, from, to)).reverse();
  const settings = await getPlatformSettings();
  const { gstRatePct } = settings.fees;
  // The GST in an amount the row has no GST of its own for, at the rate in settings (plan §5).
  const gstOf = (key: keyof EarningsRow) => (row: EarningsRow) => gstIn(row[key] as number, gstRatePct);
  const columns: [string, (row: EarningsRow) => number][] = [
    ['Rental', (row) => row.rentalCents],
    ['GST in rental', (row) => row.rentalGstCents],
    ['Delivery', (row) => row.deliveryCents],
    ['GST in delivery', (row) => row.deliveryGstCents],
    ['Extra charges', (row) => row.extraChargesCents],
    ['GST in extra charges', (row) => row.extraChargesGstCents],
    ['Kept cancellation fee', (row) => row.keptFeeCents],
    ['GST in kept cancellation fee', gstOf('keptFeeCents')],
    ['Platform commission', (row) => row.commissionCents],
    ['GST in commission', (row) => row.commissionGstCents],
    ['Host-funded refunds', (row) => row.hostFundedRefundsCents],
    ['GST in Host-funded refunds', gstOf('hostFundedRefundsCents')],
    ['Host cancellation fee', (row) => row.hostCancellationFeeCents],
    ['GST in Host cancellation fee', gstOf('hostCancellationFeeCents')],
    ['Net earnings', (row) => row.netCents],
  ];
  const header = ['Trip start (NZ)', 'Booking', 'Car', 'Status', ...columns.map(([title]) => title)];
  const nzDay = (iso: string) => {
    const { year, month, day } = toNzWallClock(new Date(iso));
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  };
  const lines = rows.map((row) =>
    [
      nzDay(row.start),
      csvText(row.ref),
      csvText(row.vehicleTitle),
      row.status,
      ...columns.map(([, cents]) => dollars(cents(row))),
    ].join(','),
  );
  const totals = columns.map(([, cents]) => dollars(rows.reduce((sum, row) => sum + cents(row), 0)));
  const gstRegistered = host.hostProfile.gstRegistered;
  const supplier = supplierOf(settings.business);
  const preface = [
    `Rento Vroom earnings statement,${csvText(`${host.firstName} ${host.lastName}`)}`,
    `Period,${label}`,
    ...(gstRegistered && host.hostProfile.gstNumber
      ? [`GST number,${csvText(host.hostProfile.gstNumber)}`]
      : []),
    ...(gstRegistered
      ? [
          `Commission charged by,${csvText(supplier.name)}`,
          ...(supplier.gstNumber ? [`Supplier GST number,${csvText(supplier.gstNumber)}`] : []),
        ]
      : []),
    'All amounts in NZD and include GST',
    '',
  ];
  const csv = [...preface, header.join(','), ...lines, ['Total', '', '', '', ...totals].join(',')].join(
    '\r\n',
  );
  return { filename: `rento-vroom-earnings-${label}.csv`, csv: `${CSV_BOM}${csv}\r\n` };
}
