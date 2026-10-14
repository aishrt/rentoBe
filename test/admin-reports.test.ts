import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { createStaff, createUser, staffAgent } from './helpers.js';

/*
 * The platform report's money (plan §5, §9 Days 19–23): every kind of money the GST summary counts, the
 * platform's fees by kind, and the CSV exports adding up to the same totals as the summary.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const nzToday = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(
    new Date(Date.now() + offsetDays * DAY_MS),
  );

/**
 * A trip starting tomorrow ($338.70, $44.18 GST, $80.10 fees) with a $23 goodwill refund and a $46 extra
 * charge ($9.20 commission); a booking cancelled today, keeping $115 of which $60 goes to the Host; and a
 * payment refunded because it came in after its booking had expired.
 */
async function money() {
  const host = await createHost();
  const guest = await createUser();
  const vehicle = await createVehicle(host._id);
  const parties = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
  const now = new Date();

  const trip = await createBookingRecord(parties, { startAt: new Date(Date.now() + DAY_MS) });
  await createPaymentRecord(trip, {
    status: 'PARTIALLY_REFUNDED',
    refunds: [
      {
        amountCents: 2300,
        reason: 'Goodwill: late handover',
        fundedBy: 'PLATFORM',
        status: 'SUCCEEDED',
        createdAt: now,
      },
    ],
  });
  const extraChargeId = new mongoose.Types.ObjectId();
  await createPaymentRecord(trip, { type: 'EXTRA_CHARGE', extraChargeId, amountCents: 4600 });
  await PayoutModel.create({
    hostId: host._id,
    bookingId: trip._id,
    type: 'EXTRA_CHARGE',
    extraChargeId,
    amountCents: 3680,
    grossCents: 4600,
    commissionCents: 920,
    commissionGstCents: 120,
    status: 'SCHEDULED',
    scheduledFor: now,
  });

  const cancelled = await createBookingRecord(parties, {
    status: 'CANCELLED',
    cancelledAt: now,
    cancellationReason: 'GUEST_CANCELLED',
    cancellationFeeCents: 11500,
    refundCents: 22370,
    hostShareCents: 6000,
  });
  await createPaymentRecord(cancelled, {
    status: 'PARTIALLY_REFUNDED',
    refunds: [
      {
        amountCents: 22370,
        reason: 'Cancellation (GUEST_CANCELLED)',
        fundedBy: 'HOST',
        status: 'SUCCEEDED',
        createdAt: now,
      },
    ],
  });

  const expired = await createBookingRecord(parties, { status: 'EXPIRED' });
  await createPaymentRecord(expired, {
    status: 'REFUNDED',
    refunds: [
      {
        amountCents: 33870,
        reason: 'Paid after the booking had ended',
        fundedBy: 'PLATFORM',
        status: 'SUCCEEDED',
        createdAt: now,
      },
    ],
  });
}

/** A CSV's rows as lists of cells. */
const rows = (csv: string) =>
  csv
    .trim()
    .split('\r\n')
    .map((line) => line.split(','));

describe('the GST summary and platform fees', () => {
  it('count extra charges, the fees kept on cancellations and refunds, and the CSVs add up to the same', async () => {
    await money();
    await createStaff();
    const admin = await staffAgent();
    const range = { from: nzToday(), to: nzToday(5) };

    const summary = await admin.get('/api/v1/admin/reports/summary').query(range);
    expect(summary.status).toBe(200);
    const { report } = summary.body;
    expect(report.money).toEqual({
      grossBookingsCents: 33870,
      // The trip, the extra charge and the fee kept, less the goodwill refund: the overview's figure.
      bookingRevenueCents: 33870 + 4600 + 11500 - 2300,
      // The goodwill refund, the cancellation's refund and the late payment's.
      refundsCents: 58540,
      platformFeesCents: 14430,
      hostPayoutsPaidCents: 0,
      extraChargesCents: 4600,
      cancellationFeesKeptCents: 11500,
      gstCollectedCents: 6218,
      gstOnPlatformFeesCents: 1882,
    });
    expect(report.fees).toEqual({
      serviceFeesCents: 2670,
      hostCommissionCents: 5340,
      cancellationFeesShareCents: 5500,
      extraChargeCommissionCents: 920,
      totalCents: 14430,
    });
    // 3/23 at 15 %: $46 → $6, $115 → $15, and the goodwill refund's $23 → $3 given back. The
    // cancellation's own refund is already out of the fee kept, and the late payment was never counted.
    expect(report.gst).toEqual({
      ratePct: 15,
      inTripsCents: 4418,
      inExtraChargesCents: 600,
      inCancellationFeesCents: 1500,
      givenBackCents: 300,
      collectedCents: 6218,
      onPlatformFeesCents: 1882,
    });

    const gst = await admin.get('/api/v1/admin/reports/export').query({ ...range, type: 'gst' });
    const gstRows = rows(gst.text);
    expect(gstRows[0]).toEqual([
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
    ]);
    expect(gstRows.at(-1)).toEqual([
      'Total',
      '338.70',
      '44.18',
      '46.00',
      '6.00',
      '115.00',
      '15.00',
      '23.00',
      '3.00',
      '62.18',
      '144.30',
      '18.82',
    ]);

    const revenue = await admin.get('/api/v1/admin/reports/export').query({ ...range, type: 'revenue' });
    expect(revenue.headers['content-disposition']).toContain(
      `rento-vroom-revenue-${range.from}-to-${range.to}.csv`,
    );
    const revenueRows = rows(revenue.text);
    expect(revenueRows[0]).toEqual([
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
    ]);
    // A row for each day with money: today's fees kept, charge and refunds, and tomorrow's trip.
    expect(revenueRows.slice(1, -1).map((row) => row[0])).toEqual(
      [nzToday(), nzToday(1)].filter((day, index, days) => days.indexOf(day) === index),
    );
    expect(revenueRows.at(-1)).toEqual([
      'Total',
      '1',
      '338.70',
      '26.70',
      '53.40',
      '115.00',
      '55.00',
      '46.00',
      '9.20',
      '144.30',
      '18.82',
      '585.40',
      '361.70',
    ]);
  });

  it("tells a cancellation's own refund from a later one by its kind, whatever its wording", async () => {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const now = new Date();
    const cancelled = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      {
        status: 'CANCELLED',
        cancelledAt: now,
        cancellationReason: 'GUEST_CANCELLED',
        cancellationFeeCents: 11500,
        refundCents: 22370,
        hostShareCents: 6000,
      },
    );
    await createPaymentRecord(cancelled, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 22370,
          reason: 'Refund under the Moderate policy',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: now,
        },
        {
          amountCents: 2300,
          reason: 'Cancellation (goodwill, after a call)',
          kind: 'STAFF',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: now,
        },
      ],
    });
    await createStaff();
    const admin = await staffAgent();

    const summary = await admin
      .get('/api/v1/admin/reports/summary')
      .query({ from: nzToday(), to: nzToday(5) });
    // Only the staff refund gives back part of the $115 kept: $23 → $3 of GST.
    expect(summary.body.report.gst).toMatchObject({ inCancellationFeesCents: 1500, givenBackCents: 300 });
  });

  it('keep a second payment’s refund and the refunds before a cancellation out of revenue, as the overview does', async () => {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000);

    // A trip going ahead, paid twice: the second payment was refunded in full and never counted.
    const paidTwice = await createBookingRecord(parties, { startAt: new Date(now + DAY_MS) });
    await createPaymentRecord(paidTwice);
    await createPaymentRecord(paidTwice, {
      status: 'REFUNDED',
      refunds: [
        {
          amountCents: 33870,
          reason: 'A second payment for a booking already paid for',
          kind: 'LATE_PAYMENT',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: at(1),
        },
      ],
    });

    // $30 goodwill, then a full-refund cancellation of the $308.70 left: nothing kept, nothing to give back.
    const allBack = await createBookingRecord(parties, {
      status: 'CANCELLED',
      cancelledAt: at(2),
      cancellationReason: 'GUEST_CANCELLED',
      cancellationFeeCents: 0,
      refundCents: 30870,
      hostShareCents: 0,
    });
    await createPaymentRecord(allBack, {
      status: 'REFUNDED',
      refunds: [
        {
          amountCents: 3000,
          reason: 'Goodwill',
          kind: 'STAFF',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: at(3),
        },
        {
          amountCents: 30870,
          reason: 'Cancellation (GUEST_CANCELLED)',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: at(2),
        },
      ],
    });

    // $23 goodwill, a cancellation keeping $115 of the $315.70 left, then $10 more given back afterwards.
    const kept = await createBookingRecord(parties, {
      status: 'CANCELLED',
      cancelledAt: at(2),
      cancellationReason: 'GUEST_CANCELLED',
      cancellationFeeCents: 11500,
      refundCents: 20070,
      hostShareCents: 6000,
    });
    await createPaymentRecord(kept, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 2300,
          reason: 'Goodwill',
          kind: 'STAFF',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: at(3),
        },
        {
          amountCents: 20070,
          reason: 'Cancellation (GUEST_CANCELLED)',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: at(2),
        },
        {
          amountCents: 1000,
          reason: 'Goodwill',
          kind: 'STAFF',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: at(1),
        },
      ],
    });
    await createStaff();
    const admin = await staffAgent();
    const range = { from: nzToday(-1), to: nzToday(5) };

    const { report } = (await admin.get('/api/v1/admin/reports/summary').query(range)).body;
    // What the platform keeps: the trip paid once ($338.70), nothing of the first cancellation, and of the
    // second $338.70 − $23 − $200.70 − $10 = $105.
    expect(report.money).toMatchObject({
      grossBookingsCents: 33870,
      bookingRevenueCents: 33870 + 11500 - 1000,
      cancellationFeesKeptCents: 11500,
      refundsCents: 33870 + 3000 + 30870 + 2300 + 20070 + 1000,
    });
    // Only the $10 after the cancellation gives back GST: $1.30.
    expect(report.gst).toMatchObject({ givenBackCents: 130, inCancellationFeesCents: 1500 });

    const overview = await admin.get('/api/v1/admin/dashboard').query(range);
    expect(overview.body.figures.bookingRevenueCents).toBe(report.money.bookingRevenueCents);
  });

  it('leave checkouts that ended unpaid out of the bookings made, the Bookings CSV and the staff lists', async () => {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    const history = (...statuses: string[]) =>
      statuses.map((status) => ({ status, at: new Date() })) as never;
    const confirmed = await createBookingRecord(parties);
    // A request the Host didn't answer was made; a checkout left unpaid, timed out or replaced wasn't.
    const request = await createBookingRecord(parties, {
      status: 'EXPIRED',
      statusHistory: history('PAYMENT_PENDING', 'PENDING', 'EXPIRED'),
    });
    await createBookingRecord(parties, {
      status: 'EXPIRED',
      statusHistory: history('PAYMENT_PENDING', 'EXPIRED'),
    });
    await createBookingRecord(parties, {
      status: 'PAYMENT_PENDING',
      statusHistory: history('PAYMENT_PENDING'),
    });
    await createStaff();
    const admin = await staffAgent();
    const range = { from: nzToday(-1), to: nzToday(20) };

    const { report } = (await admin.get('/api/v1/admin/reports/summary').query(range)).body;
    expect(report.bookings).toMatchObject({ created: 2, byStatus: { CONFIRMED: 1, EXPIRED: 1 } });
    const csv = rows(
      (await admin.get('/api/v1/admin/reports/export').query({ ...range, type: 'bookings' })).text,
    );
    expect(
      csv
        .slice(1)
        .map((row) => row[0])
        .sort(),
    ).toEqual([confirmed.ref, request.ref].sort());

    const list = (await admin.get('/api/v1/admin/bookings')).body;
    expect(list.total).toBe(2);
    expect((await admin.get('/api/v1/admin/bookings').query({ status: 'EXPIRED' })).body.total).toBe(1);
    const person = (await admin.get(`/api/v1/admin/users/${guest.id}`)).body.user;
    expect(person.bookings.map((booking: { ref: string }) => booking.ref).sort()).toEqual(
      [confirmed.ref, request.ref].sort(),
    );
  });

  it('refuses the export for support staff', async () => {
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const support = await staffAgent('sam@example.co.nz');
    const response = await support
      .get('/api/v1/admin/reports/export')
      .query({ from: nzToday(), to: nzToday(5), type: 'revenue' });
    expect(response.status).toBe(403);
  });
});
