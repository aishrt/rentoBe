import mongoose from 'mongoose';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import { stripe } from '../src/integrations/stripe.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { confirmBooking, endBooking } from '../src/modules/bookings/booking-transitions.js';
import { expirePaymentHold, expireRequest } from '../src/modules/bookings/booking.service.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { runPayout } from '../src/modules/payouts/payouts.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * The Host's money (plan §8.1, items 15, 16, 19 and 22; §8.2): the commission on the Host's booking page,
 * Host-funded refunds (only the Host's share, of the booking or an extra charge) in earnings, payouts and the
 * statement, payout and booking lists a page at a time, and how an expired or cancelled trip is explained.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const client = stripe();

let transfers: Stripe.TransferCreateParams[] = [];
let refundNumber = 0;

beforeEach(() => {
  transfers = [];
  refundNumber = 0;
  vi.spyOn(client.transfers, 'create').mockImplementation(async (params) => {
    transfers.push(params);
    return { id: `tr_${transfers.length}` } as Stripe.Response<Stripe.Transfer>;
  });
  vi.spyOn(client.transfers, 'list').mockResolvedValue({
    data: [],
  } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Transfer>>);
  vi.spyOn(client.paymentIntents, 'retrieve').mockImplementation(
    async (id) =>
      ({
        id,
        status: 'succeeded',
        latest_charge: 'ch_1',
      }) as unknown as Stripe.Response<Stripe.PaymentIntent>,
  );
  vi.spyOn(client.paymentIntents, 'cancel').mockImplementation(
    async (id) => ({ id, status: 'canceled' }) as unknown as Stripe.Response<Stripe.PaymentIntent>,
  );
  vi.spyOn(client.refunds, 'create').mockImplementation(async () => {
    refundNumber += 1;
    return { id: `re_${refundNumber}`, status: 'succeeded' } as Stripe.Response<Stripe.Refund>;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/**
 * A Host with payouts set up, a Guest, and the fixtures' confirmed trip ($267 rental, 10 % service fee, 20 %
 * commission: a $213.60 payout), started a day ago and checked in, with its TRIP payout due.
 */
async function trip() {
  const host = await createHost();
  await UserModel.updateOne(
    { _id: host._id },
    { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_host' } },
  );
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  const startAt = new Date(Date.now() - 25 * HOUR_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { status: 'PAYMENT_PENDING', startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  const payment = await createPaymentRecord(booking);
  await withTransaction((session) => confirmBooking(booking, payment, session));
  await ConditionReportModel.create({
    bookingId: booking._id,
    stage: 'CHECK_IN',
    submittedBy: host._id,
    odometer: 45_000,
    fuelOrBatteryPct: 80,
    photos: [],
  });
  const payout = (await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' }))!;
  return {
    host,
    guest,
    vehicle,
    ids: { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    booking: (await BookingModel.findById(booking._id))!,
    payment,
    payout,
  };
}

/** A paid $17.50 extra charge on the trip, with its $14 payout (commission $3.50, GST $0.46) still to be sent. */
async function withExtraCharge(parts: Awaited<ReturnType<typeof trip>>) {
  const chargeId = new mongoose.Types.ObjectId();
  await BookingModel.updateOne(
    { _id: parts.booking._id },
    {
      $push: {
        extraCharges: {
          _id: chargeId,
          type: 'EXTRA_KM',
          description: '50 km over the 750 km included',
          amountCents: 1_750,
          status: 'SUCCEEDED',
        },
      },
    },
  );
  const charge = await createPaymentRecord(parts.booking, {
    type: 'EXTRA_CHARGE',
    extraChargeId: chargeId,
    amountCents: 1_750,
  });
  const chargePayout = await PayoutModel.create({
    hostId: parts.host._id,
    bookingId: parts.booking._id,
    type: 'EXTRA_CHARGE',
    extraChargeId: chargeId,
    amountCents: 1_400,
    grossCents: 1_750,
    commissionCents: 350,
    commissionGstCents: 46,
    status: 'SCHEDULED',
    scheduledFor: new Date(),
  });
  return { charge, chargePayout };
}

const refundsOwed = async (hostId: unknown) =>
  (await UserModel.findById(hostId).lean())!.hostProfile!.refundsOwed ?? [];

/** The NZ month a date falls in, for the statement: "2026-10". */
const nzMonth = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(date).slice(0, 7);

describe('the Host’s booking page', () => {
  it('shows the commission the payout was made with, not the Guest’s service fee', async () => {
    const { host, guest, booking } = await trip();
    const view = (await (await signIn(host.email)).get(`/api/v1/bookings/${booking.ref}`)).body.booking;
    // $267 at 20 %: $53.40 with $6.97 GST, as on the payout and its email (the service fee is $26.70 more).
    expect(view.payout).toMatchObject({
      hostPayoutCents: 21_360,
      commissionCents: 5_340,
      commissionGstCents: 697,
    });
    expect(view.payout).not.toHaveProperty('platformFeeCents');

    const guestView = (await (await signIn(guest.email)).get(`/api/v1/bookings/${booking.ref}`)).body.booking;
    expect(guestView).not.toHaveProperty('payout');
  });

  it('works the commission out from the price before there’s a payout', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id);
    const request = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'PENDING', instantBook: false, requestExpiresAt: new Date(Date.now() + DAY_MS) },
    );
    const view = (await (await signIn(host.email)).get(`/api/v1/bookings/${request.ref}`)).body.booking;
    expect(view.payout).toMatchObject({ commissionCents: 5_340, commissionGstCents: 697 });
  });

  it('shows the fuel and kilometre terms as booked, with the whole trip’s allowance', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const ids = { guestId: guest._id, hostId: host._id };
    const hybrid = await createVehicle(host._id);
    const electric = await createVehicle(host._id, { fuelType: 'EV' });
    const limited = await createBookingRecord({ ...ids, vehicleId: hybrid._id });
    const unlimited = await createBookingRecord(
      { ...ids, vehicleId: electric._id },
      { terms: { fuelPolicy: 'SAME_LEVEL', unlimitedKm: true, extraKmCents: 0 } },
    );
    const agent = await signIn(host.email);

    // 250 km a day for 3 days.
    expect((await agent.get(`/api/v1/bookings/${limited.ref}`)).body.booking.terms).toEqual({
      fuelPolicy: 'SAME_LEVEL',
      unlimitedKm: false,
      kmAllowancePerDay: 250,
      allowanceKm: 750,
      extraKmCents: 35,
      electric: false,
    });
    expect((await agent.get(`/api/v1/bookings/${unlimited.ref}`)).body.booking.terms).toEqual({
      fuelPolicy: 'SAME_LEVEL',
      unlimitedKm: true,
      extraKmCents: 0,
      electric: true,
    });
  });
});

describe('Host-funded refunds', () => {
  it('cost the Host only their share, and can’t go past the rental and delivery', async () => {
    const { host, booking, payout } = await trip();
    await createStaff();
    const admin = await staffAgent();
    const refund = (body: Record<string, unknown>) =>
      admin
        .post(`/api/v1/admin/bookings/${booking.ref}/refunds`)
        .send({ reason: 'The car broke down on the first day', fundedBy: 'HOST', ...body });

    const detail = await admin.get(`/api/v1/admin/bookings/${booking.ref}`);
    expect(detail.body.hostFunding).toEqual({
      maxCents: 26_700,
      baseCents: 26_700,
      payoutCents: 21_360,
      hostLeftCents: 21_360,
    });
    // The service fee and protection aren't the Host's to fund.
    const over = await refund({ amountCents: 26_701 });
    expect(over.status).toBe(400);
    expect(over.body.error.fields.amountCents).toMatch(/up to \$267\.00/);
    expect(client.refunds.create).not.toHaveBeenCalled();

    // $50 refunded: the Host pays their 80 %, Rento Vroom its commission.
    const refunded = await refund({ amountCents: 5_000 });
    expect(refunded.status).toBe(200);
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'THIS_PAYOUT' });
    expect(refunded.body.hostFunding).toMatchObject({ maxCents: 21_700, hostLeftCents: 17_360 });
    expect((await PaymentModel.findOne({ bookingId: booking._id }).lean())!.refunds).toEqual([
      expect.objectContaining({ amountCents: 5_000, hostCents: 4_000, fundedBy: 'HOST' }),
    ]);

    expect(await runPayout(payout.id)).toBe('paid');
    expect((await PayoutModel.findById(payout._id).lean())!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_FUNDED_REFUND', stripeRefundId: 're_1', amountCents: 4_000 }),
    ]);
    expect(transfers[0]!.amount).toBe(21_360 - 4_000);

    // The rest of the rental: the Host's share left, then nothing more for the Host to fund.
    const rest = await refund({ amountCents: 21_700, recoverFrom: 'NEXT_PAYOUT' });
    expect(rest.body.hostRefund).toEqual({ recoveredFrom: 'NEXT_PAYOUT', owedCents: 17_360 });
    expect(await refundsOwed(host._id)).toEqual([
      expect.objectContaining({ stripeRefundId: 're_2', amountCents: 17_360 }),
    ]);
    const none = await refund({ amountCents: 100 });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toMatch(/Nothing the Host was paid for is left/);
    // Rento Vroom can still refund the rest itself.
    expect((await refund({ amountCents: 100, fundedBy: 'PLATFORM' })).status).toBe(200);

    const earnings = await (await signIn(host.email)).get('/api/v1/host/earnings');
    expect(earnings.body.bookings[0]).toMatchObject({ hostFundedRefundsCents: 21_360, netCents: 0 });
  });

  it('of an extra charge come off its payout, earnings, the statement and the booking page', async () => {
    const parts = await trip();
    const { charge, chargePayout } = await withExtraCharge(parts);
    await createStaff();
    const admin = await staffAgent();
    const detail = await admin.get(`/api/v1/admin/bookings/${parts.booking.ref}`);
    expect(detail.body.refundableCharges[0].hostFunding).toEqual({
      maxCents: 1_750,
      baseCents: 1_750,
      payoutCents: 1_400,
      hostLeftCents: 1_400,
    });

    const refunded = await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
      .send({ paymentId: charge.id, amountCents: 500, reason: 'The odometer was misread', fundedBy: 'HOST' });
    expect(refunded.status).toBe(200);
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'THIS_PAYOUT' });

    expect(await runPayout(chargePayout.id)).toBe('paid');
    // $5 refunded: the Host's share of the $17.50 charge is $14, so $4 of it.
    expect((await PayoutModel.findById(chargePayout._id).lean())!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_FUNDED_REFUND', amountCents: 400 }),
    ]);
    expect(transfers.at(-1)!.amount).toBe(1_000);

    const agent = await signIn(parts.host.email);
    const row = (await agent.get('/api/v1/host/earnings')).body.bookings[0];
    expect(row).toMatchObject({
      extraChargesCents: 1_750,
      commissionCents: 5_340 + 350,
      // Each payout's own GST: $6.97 + $0.46, not GST on the combined $56.90 ($7.42).
      commissionGstCents: 697 + 46,
      hostFundedRefundsCents: 400,
      netCents: 21_360 + 1_400 - 400,
    });
    const statement = await agent
      .get('/api/v1/host/earnings/statement')
      .query({ period: nzMonth(parts.booking.startAt) });
    expect(statement.text).toContain(
      'Kept cancellation fee,GST in kept cancellation fee,Platform commission,GST in commission,Host-funded refunds,GST in Host-funded refunds,Host cancellation fee,GST in Host cancellation fee,Net earnings',
    );
    // Rental, delivery and extra charges with their GST, the kept fee, commission, refunds and fees.
    expect(statement.text).toContain(
      `${parts.booking.ref},2021 Toyota Corolla,CONFIRMED,267.00,34.83,0.00,0.00,17.50,2.28,0.00,0.00,56.90,7.43,4.00,0.52,0.00,0.00,223.60`,
    );
    expect(statement.text).toMatch(/Total,,,,267\.00,.*,223\.60\r\n$/);

    const view = (await agent.get(`/api/v1/bookings/${parts.booking.ref}`)).body.booking;
    expect(view.payout.refunds).toEqual([
      { amountCents: 500, at: expect.any(String), fundedBy: 'HOST', hostCents: 400, extraCharge: true },
    ]);
  });

  it('still to come off a trip payout are owed when the payout is cancelled', async () => {
    const { host, booking, payout } = await trip();
    await createStaff();
    const admin = await staffAgent();
    await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'Car was not cleaned', fundedBy: 'HOST' });
    expect(await refundsOwed(host._id)).toEqual([]);

    await withTransaction((session) =>
      endBooking(
        booking,
        {
          to: 'CANCELLED',
          from: ['CONFIRMED'],
          cancellation: {
            reason: 'PLATFORM',
            refundCents: 28_870,
            feeCents: 0,
            hostShareCents: 0,
            hostFeeCents: 0,
          },
        },
        session,
      ),
    );
    expect((await PayoutModel.findById(payout._id).lean())!.status).toBe('CANCELLED');
    expect(await refundsOwed(host._id)).toEqual([
      expect.objectContaining({ stripeRefundId: 're_1', amountCents: 4_000, bookingId: booking._id }),
    ]);
  });

  it('count only the Host’s share as theirs in the staff reports', async () => {
    const { booking } = await trip();
    await createStaff();
    const admin = await staffAgent();
    const refund = (body: Record<string, unknown>) =>
      admin
        .post(`/api/v1/admin/bookings/${booking.ref}/refunds`)
        .send({ reason: 'The car broke down on the first day', ...body });
    expect((await refund({ amountCents: 5_000, fundedBy: 'HOST' })).status).toBe(200);
    expect((await refund({ amountCents: 100, fundedBy: 'PLATFORM' })).status).toBe(200);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());
    const range = { from: today, to: today };
    const csv = async (type: string) =>
      (await admin.get('/api/v1/admin/reports/export').query({ ...range, type })).text
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(','));
    // $1 Rento Vroom refunded itself, and its $10 commission on the Host-funded $50.
    const revenue = await csv('revenue');
    const column = revenue[0]!.indexOf('Refunds funded by the platform');
    expect(revenue.at(-1)![column]).toBe('11.00');
    const refunds = await csv('refunds');
    expect(refunds[0]).toContain('Host pays');
    const hostPays = refunds[0]!.indexOf('Host pays');
    expect(refunds.slice(1).map((row) => row[hostPays])).toEqual(['40.00', '0.00']);
    // The staff Refunds page shows the Host's share too.
    const list = await admin.get('/api/v1/admin/refunds');
    expect(list.body.refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amountCents: 5_000, fundedBy: 'HOST', hostCents: 4_000 }),
      ]),
    );
  });
});

describe('payouts', () => {
  it('list those still to be sent soonest first, net of reserved deductions, and paid ones a page at a time', async () => {
    const { host, booking } = await trip();
    await PayoutModel.deleteMany({ hostId: host._id });
    // One booking's extra charges' payouts, each its own.
    const base = { hostId: host._id, bookingId: booking._id, type: 'EXTRA_CHARGE' as const };
    const charge = () => ({ extraChargeId: new mongoose.Types.ObjectId() });
    const later = await PayoutModel.create({
      ...base,
      ...charge(),
      amountCents: 10_000,
      status: 'SCHEDULED',
      scheduledFor: new Date(Date.now() + 9 * DAY_MS),
    });
    // A transfer that failed after its deductions were taken: it sends $188.60.
    const sooner = await PayoutModel.create({
      ...base,
      ...charge(),
      amountCents: 21_360,
      status: 'FAILED',
      scheduledFor: new Date(Date.now() - DAY_MS),
      deductionsReservedAt: new Date(),
      deductions: [{ type: 'HOST_CANCELLATION_FEE', amountCents: 2_500, owed: true }],
    });
    await PayoutModel.insertMany(
      Array.from({ length: 13 }, (_, index) => ({
        ...base,
        ...charge(),
        amountCents: 1_000 + index,
        status: 'PAID',
        scheduledFor: new Date(Date.now() - (index + 2) * DAY_MS),
        paidAt: new Date(Date.now() - (index + 2) * DAY_MS),
      })),
    );
    const agent = await signIn(host.email);

    const first = (await agent.get('/api/v1/host/payouts')).body;
    expect(first.payouts.slice(0, 2).map((payout: { id: string }) => payout.id)).toEqual([
      sooner.id,
      later.id,
    ]);
    expect(first.payouts[0]).toMatchObject({ amountCents: 18_860, status: 'FAILED' });
    const paid = first.payouts.filter((payout: { status: string }) => payout.status === 'PAID');
    expect(paid).toHaveLength(12);
    expect(paid[0].amountCents).toBe(1_000);
    expect(first.paidCount).toBe(13);
    expect(first.nextCursor).toBe(paid[11].id);

    const next = (await agent.get('/api/v1/host/payouts').query({ cursor: first.nextCursor })).body;
    expect(next.payouts.map((payout: { amountCents: number }) => payout.amountCents)).toEqual([1_012]);
    expect(next).not.toHaveProperty('nextCursor');

    const earnings = (await agent.get('/api/v1/host/earnings')).body;
    expect(earnings.summary.upcomingPayoutsCents).toBe(18_860 + 10_000);
  });

  it('stay paid when a run at the same moment fails after another sent it', async () => {
    const { payout } = await trip();
    vi.mocked(client.transfers.create).mockImplementationOnce(async () => {
      await PayoutModel.updateOne({ _id: payout._id }, { $set: { status: 'PAID', paidAt: new Date() } });
      throw new Stripe.errors.StripeAPIError({ message: 'Stripe is having a moment', statusCode: 500 });
    });
    expect(await runPayout(payout.id)).toBe('skipped');
    expect((await PayoutModel.findById(payout._id).lean())!.status).toBe('PAID');
  });
});

describe('the Host’s lists', () => {
  it('give bookings a page at a time', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id);
    const ids = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        createBookingRecord(ids, {
          status: 'COMPLETED',
          startAt: new Date(Date.now() - (index + 5) * DAY_MS),
          endAt: new Date(Date.now() - (index + 2) * DAY_MS),
        }),
      ),
    );
    const agent = await signIn(host.email);
    const query = { role: 'host', group: 'completed' };
    const first = (await agent.get('/api/v1/bookings').query(query)).body;
    expect(first.bookings).toHaveLength(100);
    expect(first.nextPage).toBe(2);
    const second = (await agent.get('/api/v1/bookings').query({ ...query, page: 2 })).body;
    expect(second.bookings).toHaveLength(1);
    expect(second).not.toHaveProperty('nextPage');
    const refs = new Set(
      [...first.bookings, ...second.bookings].map((booking: { ref: string }) => booking.ref),
    );
    expect(refs.size).toBe(101);
  });

  it('send the Road User Charges to-do to the documents step', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id, { fuelType: 'DIESEL', rucValidToKm: 45_500 });
    const earlier = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'COMPLETED', startAt: new Date(Date.now() - 20 * DAY_MS) },
    );
    await ConditionReportModel.create({
      bookingId: earlier._id,
      stage: 'CHECK_OUT',
      submittedBy: guest._id,
      odometer: 45_000,
      fuelOrBatteryPct: 80,
      photos: [],
    });
    const { items } = (await (await signIn(host.email)).get('/api/v1/host/todo')).body;
    expect(items.find((item: { kind: string }) => item.kind === 'RUC')).toMatchObject({
      link: `/host/vehicles/${vehicle.id}/2`,
    });
  });
});

describe('an ended trip, as the Guest sees it', () => {
  async function parties() {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id);
    return { host, guest, ids: { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id } };
  }
  const expiry = async (email: string, ref: string) =>
    (await (await signIn(email)).get(`/api/v1/bookings/${ref}`)).body.booking.expiry;

  it('says why it expired', async () => {
    const { guest, ids } = await parties();
    const unpaid = await createBookingRecord(ids, {
      status: 'PAYMENT_PENDING',
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    expect(await expirePaymentHold(unpaid.id)).toBe('expired');
    const request = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() - 60_000),
    });
    const instant = await createBookingRecord(ids, {
      status: 'PENDING',
      requestExpiresAt: new Date(Date.now() - 60_000),
      verificationReview: { status: 'PENDING' },
    });
    for (const pending of [request, instant]) expect(await expireRequest(pending.id)).toBe(true);

    expect(await expiry(guest.email, unpaid.ref)).toEqual({
      reason: 'PAYMENT_TIMEOUT',
      paymentReturned: false,
    });
    expect(await expiry(guest.email, request.ref)).toEqual({
      reason: 'HOST_NO_ANSWER',
      paymentReturned: false,
    });
    // An Instant Book never waits for its Host: only for the Guest's verification.
    expect(await expiry(guest.email, instant.ref)).toEqual({
      reason: 'VERIFICATION_EXPIRED',
      paymentReturned: false,
    });
  });

  it('says a payment that went through after it ended is refunded in full', async () => {
    const { guest, ids } = await parties();
    const expired = (reason: string) =>
      createBookingRecord(ids, {
        status: 'EXPIRED',
        paymentReturnedAt: new Date(),
        statusHistory: [
          { status: 'PAYMENT_PENDING', at: new Date(Date.now() - HOUR_MS) },
          { status: 'EXPIRED', at: new Date(), reason },
        ],
      });
    const late = await expired('Payment not completed in time');
    await createPaymentRecord(late, {
      status: 'REFUNDED',
      refunds: [
        {
          amountCents: 33_870,
          reason: 'Paid after the booking had ended',
          kind: 'LATE_PAYMENT',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: new Date(),
        },
      ],
    });
    const taken = await expired('The dates were booked by someone else while the payment was processing');
    await createPaymentRecord(taken);

    expect(await expiry(guest.email, late.ref)).toEqual({
      reason: 'PAYMENT_TIMEOUT',
      paymentReturned: true,
      refundCents: 33_870,
      refundStatus: 'SUCCEEDED',
    });
    // Not refunded yet: the refund is on its way.
    expect(await expiry(guest.email, taken.ref)).toEqual({
      reason: 'DATES_TAKEN',
      paymentReturned: true,
      refundCents: 33_870,
      refundStatus: 'PENDING',
    });
  });

  it('says where a cancellation’s refund stands', async () => {
    const { guest, ids } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancellationReason: 'GUEST_CANCELLED',
      refundCents: 19_185,
      cancellationFeeCents: 14_685,
    });
    await createPaymentRecord(booking, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 19_185,
          reason: 'Cancellation (GUEST_CANCELLED)',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'FAILED',
          createdAt: new Date(),
        },
      ],
    });
    const view = (await (await signIn(guest.email)).get(`/api/v1/bookings/${booking.ref}`)).body.booking;
    expect(view.cancellation).toMatchObject({ refundCents: 19_185, refundStatus: 'FAILED' });
  });
});
