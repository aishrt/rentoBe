import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import { stripe } from '../src/integrations/stripe.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { confirmBooking } from '../src/modules/bookings/booking-transitions.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { runPayout } from '../src/modules/payouts/payouts.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * The Host's money on their booking page, earnings page, statement and payout emails (plan §8.1, items 10, 15,
 * 19 and 22): what a booking earned, matching its earnings row, with what its payouts settled for other
 * bookings; a cancelled booking's kept share and a payout already sent, owed back; what the upcoming payouts
 * bring after what the Host owes; any month's trips; and the supplier on a GST-registered Host's statement.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const client = stripe();
let refundNumber = 0;

const FLEXIBLE = {
  code: 'FLEXIBLE',
  name: 'Flexible',
  summary: 'Full refund up to 24 hours before pickup, then 50%.',
  refunds: [
    { minHoursBefore: 24, refundPct: 100 },
    { minHoursBefore: 0, refundPct: 50 },
  ],
};

beforeEach(() => {
  refundNumber = 0;
  let transfers = 0;
  vi.spyOn(client.transfers, 'create').mockImplementation(async () => {
    transfers += 1;
    return { id: `tr_${transfers}` } as Stripe.Response<Stripe.Transfer>;
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

const nzMonth = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(date).slice(0, 7);

/**
 * A Host with payouts set up and a confirmed trip ($267 rental, 20 % commission: a $213.60 payout) that started
 * `daysAgo` days ago and was checked in, with its TRIP payout due.
 */
async function trip(
  parties?: { host: Awaited<ReturnType<typeof createHost>>; guest: Awaited<ReturnType<typeof createUser>> },
  daysAgo = 25 / 24,
) {
  const host = parties?.host ?? (await createHost());
  await UserModel.updateOne(
    { _id: host._id },
    { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_host' } },
  );
  const guest = parties?.guest ?? (await createUser({ email: 'kiri@example.co.nz' }));
  const vehicle = await createVehicle(host._id);
  const startAt = new Date(Date.now() - daysAgo * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    {
      status: 'PAYMENT_PENDING',
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      cancellationPolicy: 'FLEXIBLE',
      cancellationTerms: FLEXIBLE,
    },
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
  return { host, guest, booking: (await BookingModel.findById(booking._id))!, payout };
}

/** A paid $17.50 extra charge on the trip, with its $14 payout due now. */
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
  await createPaymentRecord(parts.booking, {
    type: 'EXTRA_CHARGE',
    extraChargeId: chargeId,
    amountCents: 1_750,
  });
  return PayoutModel.create({
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
}

const emailRows = async (payoutId: string) =>
  (
    (await NotificationModel.findOne({ dedupeKey: `PAYOUT_PAID:${payoutId}`, channel: 'EMAIL' }))!
      .payload as {
      props: { rows: { label: string; value: string }[] };
    }
  ).props.rows;

describe('the Host’s booking page', () => {
  it('shows what the booking earned, as its earnings row, and what its payouts settled for other bookings', async () => {
    const parts = await trip();
    const chargePayout = await withExtraCharge(parts);
    // A $50 Host cancellation fee owed from another booking.
    await UserModel.updateOne({ _id: parts.host._id }, { $set: { 'hostProfile.feesOwedCents': 5_000 } });
    await createStaff();
    const admin = await staffAgent();
    const refund = await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'The car wasn’t cleaned', fundedBy: 'HOST' });
    expect(refund.status).toBe(200);
    expect(await runPayout(parts.payout.id)).toBe('paid');
    expect(await runPayout(chargePayout.id)).toBe('paid');

    const agent = await signIn(parts.host.email);
    const row = (await agent.get('/api/v1/host/earnings')).body.bookings[0];
    const { payout } = (await agent.get(`/api/v1/bookings/${parts.booking.ref}`)).body.booking;
    // $267 and $17.50, less $56.90 commission and the Host's $40 share of the $50 refund.
    expect(payout.earnings).toMatchObject({
      rentalCents: 26_700,
      extraChargesCents: 1_750,
      commissionCents: 5_690,
      hostFundedRefundsCents: 4_000,
      netCents: 18_760,
    });
    expect(payout.earnings.netCents).toBe(row.netCents);
    // The trip's payout took the refund and the fee owed: $123.60, and $14 for the charge. The fee was settled
    // from it, so with it the payouts come to what the booking earned.
    expect(payout.paidCents).toBe(12_360 + 1_400);
    expect(payout.settled).toEqual([{ type: 'HOST_CANCELLATION_FEE', amountCents: 5_000 }]);
    expect(payout.paidCents + 5_000).toBe(payout.earnings.netCents);
    expect(payout).not.toHaveProperty('owed');
  });

  it('shows a cancelled booking’s kept share, the payout already sent and what is owed back, then where it was taken', async () => {
    const parts = await trip();
    expect(await runPayout(parts.payout.id)).toBe('paid');
    await createStaff();
    const admin = await staffAgent();
    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The Guest never arrived' });
    expect(cancelled.status).toBe(200);

    const agent = await signIn(parts.host.email);
    const view = (await agent.get(`/api/v1/bookings/${parts.booking.ref}`)).body.booking;
    // Half the rental kept under the Flexible policy: $106.80 is the Host's. $213.60 was already sent.
    expect(view.cancellation).toMatchObject({ by: 'SUPPORT', hostShareCents: 10_680 });
    expect(view.payout).toMatchObject({
      paidCents: 21_360,
      earnings: { netCents: 10_680 },
      owed: { refundsCents: 0, payoutSentCents: 10_680 },
    });
    expect((await agent.get('/api/v1/host/payouts')).body.account).toMatchObject({
      refundsOwedCents: 0,
      payoutsOwedCents: 10_680,
    });

    // The next trip's payout takes it back, labelled as the payout already sent rather than a refund.
    const next = await trip({ host: parts.host, guest: parts.guest }, 3);
    expect(await runPayout(next.payout.id)).toBe('paid');
    const rows = await emailRows(next.payout.id);
    expect(rows).toContainEqual({ label: `Payout already sent for ${parts.booking.ref}`, value: '−$106.80' });
    const listed = (await agent.get('/api/v1/host/payouts')).body.payouts.find(
      (payout: { id: string }) => payout.id === next.payout.id,
    );
    expect(listed.deductions).toEqual([
      { type: 'HOST_FUNDED_REFUND', amountCents: 10_680, bookingRef: parts.booking.ref, payoutSent: true },
    ]);
    const after = (await agent.get(`/api/v1/bookings/${parts.booking.ref}`)).body.booking.payout;
    expect(after).not.toHaveProperty('owed');
    expect(after.settledElsewhere).toEqual([
      { amountCents: 10_680, bookingRef: next.booking.ref, payoutSent: true },
    ]);
    expect((await agent.get(`/api/v1/bookings/${next.booking.ref}`)).body.booking.payout.settled).toEqual([
      { type: 'HOST_FUNDED_REFUND', amountCents: 10_680, bookingRef: parts.booking.ref, payoutSent: true },
    ]);
  });

  it('shows a Host cancellation fee less any part waived', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id);
    const booking = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: host._id,
        cancellationReason: 'HOST_CANCELLED',
        refundCents: 33_870,
        hostShareCents: 0,
        hostCancellationFeeCents: 5_000,
        hostCancellationFeeWaivedCents: 3_000,
      },
    );
    const view = (await (await signIn(host.email)).get(`/api/v1/bookings/${booking.ref}`)).body.booking;
    expect(view.cancellation).toMatchObject({ by: 'HOST', hostFeeCents: 2_000 });
    expect(view.payout.earnings).toMatchObject({ hostCancellationFeeCents: 2_000, netCents: -2_000 });
  });
});

describe('the earnings page', () => {
  it('counts upcoming payouts after the refunds and fees that will come off them', async () => {
    const parts = await trip();
    await UserModel.updateOne({ _id: parts.host._id }, { $set: { 'hostProfile.feesOwedCents': 5_000 } });
    await createStaff();
    const admin = await staffAgent();
    await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'The car wasn’t cleaned', fundedBy: 'HOST' });

    const agent = await signIn(parts.host.email);
    // $213.60, less the Host's $40 share of the refund and the $50 fee.
    expect((await agent.get('/api/v1/host/earnings')).body.summary.upcomingPayoutsCents).toBe(12_360);
    expect(await runPayout(parts.payout.id)).toBe('paid');
    expect((await PayoutModel.findById(parts.payout._id).lean())!.amountCents).toBe(12_360);
  });

  it('gives every trip of any month asked for, and the months with trips', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id);
    const ids = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    const longAgo = new Date(Date.now() - 400 * DAY_MS);
    const old = await createBookingRecord(ids, { status: 'COMPLETED', startAt: longAgo });
    await createBookingRecord(ids, { status: 'COMPLETED', startAt: new Date(Date.now() - 5 * DAY_MS) });
    const agent = await signIn(host.email);

    const all = (await agent.get('/api/v1/host/earnings')).body;
    expect(all.tripMonths).toContain(nzMonth(longAgo));
    const month = (await agent.get('/api/v1/host/earnings').query({ month: nzMonth(longAgo) })).body;
    expect(month.bookings.map((row: { ref: string }) => row.ref)).toEqual([old.ref]);
    expect((await agent.get('/api/v1/host/earnings').query({ month: '2026-13' })).status).toBe(400);
  });

  it('names Rento Vroom as the supplier for a GST-registered Host, on the page, the statement and the email', async () => {
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { business: { legalName: 'Rento Vroom Limited', gstNumber: '123-456-789' } },
    });
    const parts = await trip();
    await UserModel.updateOne(
      { _id: parts.host._id },
      { $set: { 'hostProfile.gstRegistered': true, 'hostProfile.gstNumber': '987-654-321' } },
    );
    // A car title that could be read as a formula, and a macron.
    await BookingModel.updateOne(
      { _id: parts.booking._id },
      { $set: { 'vehicleSnapshot.title': '=HYPERLINK("x") Mōkihi' } },
    );
    expect(await runPayout(parts.payout.id)).toBe('paid');
    const agent = await signIn(parts.host.email);

    expect((await agent.get('/api/v1/host/earnings')).body).toMatchObject({
      gstRegistered: true,
      supplier: { name: 'Rento Vroom Limited', gstNumber: '123-456-789' },
    });
    const statement = await agent
      .get('/api/v1/host/earnings/statement')
      .query({ period: nzMonth(parts.booking.startAt) })
      .buffer(true)
      .parse((response, done) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => done(null, text));
      });
    const csv = statement.body as string;
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('GST number,987-654-321\r\n');
    expect(csv).toContain('Commission charged by,Rento Vroom Limited\r\nSupplier GST number,123-456-789\r\n');
    expect(csv).toContain(`,${parts.booking.ref},"'=HYPERLINK(""x"") Mōkihi",CONFIRMED,`);
    expect(await emailRows(parts.payout.id)).toContainEqual({
      label: 'Commission charged by',
      value: 'Rento Vroom Limited, GST number 123-456-789',
    });
  });

  it('leaves the supplier off for a Host who isn’t GST-registered', async () => {
    const parts = await trip();
    expect(await runPayout(parts.payout.id)).toBe('paid');
    const agent = await signIn(parts.host.email);
    expect((await agent.get('/api/v1/host/earnings')).body).not.toHaveProperty('supplier');
    const statement = await agent
      .get('/api/v1/host/earnings/statement')
      .query({ period: nzMonth(parts.booking.startAt) });
    expect(statement.text).not.toContain('Commission charged by');
    expect((await emailRows(parts.payout.id)).map((row) => row.label)).not.toContain('Commission charged by');
  });
});
