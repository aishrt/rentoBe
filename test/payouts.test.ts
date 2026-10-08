import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { tripExtraChargesJob } from '../src/jobs/handlers/payout-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { confirmBooking, endBooking } from '../src/modules/bookings/booking-transitions.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { collectExtraCharge } from '../src/modules/payments/extra-charges.service.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { runPayout } from '../src/modules/payouts/payouts.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel, liveVehicleFilter } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createUser, testApp } from './helpers.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const client = stripe();
const app = testApp();
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;

let transfers: Stripe.TransferCreateParams[] = [];

beforeEach(() => {
  transfers = [];
  vi.spyOn(client.transfers, 'create').mockImplementation(async (params) => {
    transfers.push(params);
    return { id: `tr_${transfers.length}` } as Stripe.Response<Stripe.Transfer>;
  });
  vi.spyOn(client.paymentIntents, 'retrieve').mockImplementation(
    async (id) =>
      ({
        id,
        status: 'succeeded',
        latest_charge: 'ch_1',
        payment_method: 'pm_saved',
      }) as unknown as Stripe.Response<Stripe.PaymentIntent>,
  );
  vi.spyOn(client.customers, 'create').mockResolvedValue({ id: 'cus_1' } as Stripe.Response<Stripe.Customer>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function webhook(type: string, object: object, secret = env.STRIPE_WEBHOOK_SECRET!) {
  const payload = JSON.stringify({
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type,
    api_version: '2026-08-26.dahlia',
    created: 1_790_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  });
  return request(app)
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', Stripe.webhooks.generateTestHeaderString({ payload, secret }))
    .send(payload);
}

/** A Host with payouts set up (or not), a Guest, and a confirmed booking that started a day ago. */
async function trip({ payoutsEnabled = true, started = true } = {}) {
  const host = await createHost();
  await UserModel.updateOne(
    { _id: host._id },
    { $set: { 'hostProfile.payoutsEnabled': payoutsEnabled, 'hostProfile.stripeAccountId': 'acct_host' } },
  );
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  const startAt = started ? new Date(Date.now() - 25 * HOUR_MS) : new Date(Date.now() + 10 * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { status: 'PAYMENT_PENDING', startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  const payment = await createPaymentRecord(booking);
  await withTransaction((session) => confirmBooking(booking, payment, session));
  const payout = await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' });
  return {
    host,
    guest,
    vehicle,
    booking: (await BookingModel.findById(booking._id))!,
    payment,
    payout: payout!,
  };
}

async function checkIn(bookingId: unknown, by: unknown) {
  await ConditionReportModel.create({
    bookingId,
    stage: 'CHECK_IN',
    submittedBy: by,
    odometer: 45000,
    fuelOrBatteryPct: 80,
    photos: [],
  });
}

describe('trip payouts', () => {
  it('are scheduled for 24 hours after the trip starts, with the commission and its GST', async () => {
    const { booking, payout } = await trip({ started: false });
    expect(payout).toMatchObject({
      status: 'SCHEDULED',
      amountCents: 21360,
      grossCents: 26700,
      commissionCents: 5340,
      commissionGstCents: 697,
    });
    expect(payout.scheduledFor.getTime()).toBe(booking.startAt.getTime() + 24 * HOUR_MS);
    expect(await JobModel.countDocuments({ type: 'payout.transfer', refId: booking.id })).toBe(1);
  });

  it('wait for check-in, then pay with Host cancellation fees taken off', async () => {
    const { booking, payout, host } = await trip();
    expect(await runPayout(payout.id)).toBe('held');
    expect(await PayoutModel.findById(payout._id)).toMatchObject({
      status: 'HELD',
      holdReason: 'TRIP_NOT_STARTED',
    });

    await checkIn(booking._id, host._id);
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 2500 } });
    expect(await runPayout(payout.id)).toBe('paid');
    expect(transfers).toEqual([
      expect.objectContaining({
        amount: 21360 - 2500,
        currency: 'nzd',
        destination: 'acct_host',
        source_transaction: 'ch_1',
        transfer_group: booking.ref,
      }),
    ]);
    const paid = await PayoutModel.findById(payout._id);
    expect(paid).toMatchObject({ status: 'PAID', amountCents: 18860, stripeTransferId: 'tr_1' });
    expect(paid!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_CANCELLATION_FEE', amountCents: 2500 }),
    ]);
    expect((await UserModel.findById(host._id))!.hostProfile!.feesOwedCents).toBe(0);
    expect(
      await NotificationModel.countDocuments({ userId: host._id, type: 'PAYOUT_PAID', channel: 'EMAIL' }),
    ).toBe(1);

    // Again: nothing is sent twice.
    expect(await runPayout(payout.id)).toBe('skipped');
    expect(transfers).toHaveLength(1);
  });

  it('are held without payout setup, and released when Stripe says the account is ready', async () => {
    const { payout, host, booking, vehicle } = await trip({ payoutsEnabled: false });
    await checkIn(booking._id, host._id);
    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { payoutsReady: false } });
    expect(await runPayout(payout.id)).toBe('held');
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ holdReason: 'PAYOUT_SETUP' });
    expect(
      await NotificationModel.countDocuments({ userId: host._id, type: 'PAYOUT_SETUP_NEEDED' }),
    ).toBeGreaterThan(0);

    // Stripe's Connect endpoint has its own secret.
    const updated = await webhook(
      'account.updated',
      {
        id: 'acct_host',
        object: 'account',
        payouts_enabled: true,
        capabilities: { transfers: 'active' },
        requirements: { currently_due: [], past_due: [] },
        settings: { payouts: { schedule: { delay_days: 3 } } },
      },
      'whsec_connect',
    );
    expect(updated.status).toBe(200);
    expect((await UserModel.findById(host._id))!.hostProfile).toMatchObject({
      payoutsEnabled: true,
      payoutDelayDays: 3,
    });
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'SCHEDULED' });
    expect(await VehicleModel.exists({ _id: vehicle._id, ...liveVehicleFilter() })).toBeTruthy();
  });

  it('are held while an incident is open or a card dispute is under way', async () => {
    const { payout, booking, host, guest, payment } = await trip();
    await checkIn(booking._id, host._id);
    const incident = await IncidentModel.create({
      caseRef: 'IN-PAY234',
      bookingId: booking._id,
      reporterId: guest._id,
      type: 'DAMAGE',
      description: 'Dent',
    });
    expect(await runPayout(payout.id)).toBe('held');
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ holdReason: 'INCIDENT' });
    await IncidentModel.updateOne({ _id: incident._id }, { $set: { status: 'RESOLVED' } });

    const dispute = {
      id: 'dp_1',
      object: 'dispute',
      payment_intent: payment.stripePaymentIntentId,
      reason: 'fraudulent',
      status: 'needs_response',
    };
    expect((await webhook('charge.dispute.created', dispute)).status).toBe(200);
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'HELD', holdReason: 'DISPUTE' });
    expect(await runPayout(payout.id)).toBe('held');
    await webhook('charge.dispute.closed', { ...dispute, status: 'won' });
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'SCHEDULED' });
    expect(await runPayout(payout.id)).toBe('paid');
  });

  it('are replaced by the Host’s share of a kept fee when the guest cancels', async () => {
    const { booking } = await trip({ started: false });
    await withTransaction((session) =>
      endBooking(
        booking,
        {
          to: 'CANCELLED',
          from: ['CONFIRMED'],
          cancellation: {
            reason: 'GUEST_CANCELLED',
            refundCents: 20000,
            feeCents: 13870,
            hostShareCents: 10680,
            hostFeeCents: 0,
          },
        },
        session,
      ),
    );
    expect(await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' })).toMatchObject({
      status: 'CANCELLED',
    });
    expect(await PayoutModel.findOne({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toMatchObject({
      status: 'SCHEDULED',
      amountCents: 10680,
    });
  });
});

describe('payout setup', () => {
  it('makes the Host’s Stripe account once and sends them to Stripe’s pages', async () => {
    const host = await createHost();
    const create = vi
      .spyOn(client.accounts, 'create')
      .mockResolvedValue({ id: 'acct_new' } as Stripe.Response<Stripe.Account>);
    vi.spyOn(client.accountLinks, 'create').mockResolvedValue({
      url: 'https://connect.stripe.com/setup/e/acct_new/abc',
    } as Stripe.Response<Stripe.AccountLink>);
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: host.email, password: PASSWORD });

    const first = await agent.post('/api/v1/host/connect/onboarding-link');
    expect(first.body.url).toMatch(/^https:\/\/connect\.stripe\.com/);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'express',
        country: 'NZ',
        capabilities: { transfers: { requested: true } },
      }),
      expect.anything(),
    );
    await agent.post('/api/v1/host/connect/onboarding-link');
    expect(create).toHaveBeenCalledTimes(1);

    const payouts = await agent.get('/api/v1/host/payouts');
    expect(payouts.body.account).toMatchObject({ connected: true, payoutsEnabled: false });
  });
});

describe('extra charges', () => {
  async function completedTrip() {
    const parts = await trip();
    await BookingModel.updateOne({ _id: parts.booking._id }, { $set: { status: 'COMPLETED' } });
    await checkIn(parts.booking._id, parts.host._id);
    await ConditionReportModel.create({
      bookingId: parts.booking._id,
      stage: 'CHECK_OUT',
      submittedBy: parts.guest._id,
      odometer: 45800,
      fuelOrBatteryPct: 80,
      photos: [],
    });
    return parts;
  }

  it('charge extra kilometres to the saved card and pay the Host their share', async () => {
    const { booking, guest } = await completedTrip();
    vi.spyOn(client.paymentIntents, 'create').mockImplementation(
      async (params) =>
        ({
          id: 'pi_extra',
          status: 'succeeded',
          amount: params.amount,
        }) as unknown as Stripe.Response<Stripe.PaymentIntent>,
    );
    await tripExtraChargesJob({ bookingId: booking.id }, context);
    const charged = (await BookingModel.findById(booking._id))!.extraCharges;
    // 800 km driven, 750 included: 50 extra at 35 cents.
    expect(charged).toEqual([
      expect.objectContaining({ type: 'EXTRA_KM', amountCents: 1750, status: 'PENDING' }),
    ]);

    expect(await collectExtraCharge(booking.id, charged[0]!._id!.toString(), 1)).toBe('paid');
    expect((await BookingModel.findById(booking._id))!.extraCharges[0]).toMatchObject({
      status: 'SUCCEEDED',
    });
    expect(await PaymentModel.findOne({ type: 'EXTRA_CHARGE' })).toMatchObject({
      status: 'SUCCEEDED',
      amountCents: 1750,
    });
    expect(await PayoutModel.findOne({ bookingId: booking._id, type: 'EXTRA_CHARGE' })).toMatchObject({
      grossCents: 1750,
      commissionCents: 350,
      amountCents: 1400,
    });
    expect(
      await NotificationModel.countDocuments({ userId: guest._id, type: 'EXTRA_CHARGE_PAID' }),
    ).toBeGreaterThan(0);
  });

  it('send the Guest a link to pay when the saved card is declined', async () => {
    const { booking, guest } = await completedTrip();
    vi.spyOn(client.paymentIntents, 'create').mockRejectedValue(
      new Stripe.errors.StripeCardError({
        message: 'Your card was declined.',
        type: 'card_error',
        payment_intent: { id: 'pi_declined', status: 'requires_payment_method' } as Stripe.PaymentIntent,
      }),
    );
    await tripExtraChargesJob({ bookingId: booking.id }, context);
    const charge = (await BookingModel.findById(booking._id))!.extraCharges[0]!;
    expect(await collectExtraCharge(booking.id, charge._id!.toString(), 1)).toBe('failed');

    const payment = await PaymentModel.findOne({ stripePaymentIntentId: 'pi_declined' });
    expect(payment).toMatchObject({ status: 'FAILED', failureReason: 'Your card was declined.' });
    const told = await NotificationModel.findOne({
      userId: guest._id,
      type: 'EXTRA_CHARGE_FAILED',
      channel: 'IN_APP',
    });
    expect(told!.payload).toMatchObject({ link: `/pay/${payment!.id}` });
    expect(await JobModel.countDocuments({ type: 'extraCharge.collect', 'payload.attempt': 2 })).toBe(1);

    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });
    const link = await agent.get(`/api/v1/payments/${payment!.id}`);
    expect(link.body.payment).toMatchObject({ amountCents: 1750, status: 'DUE', bookingRef: booking.ref });
  });
});

describe('earnings', () => {
  it('count each trip on its start date, net of commission, with a GST-ready statement', async () => {
    const { host, booking } = await trip();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: host.email, password: PASSWORD });

    const earnings = await agent.get('/api/v1/host/earnings');
    expect(earnings.status).toBe(200);
    expect(earnings.body.bookings[0]).toMatchObject({
      ref: booking.ref,
      rentalCents: 26700,
      rentalGstCents: 3483,
      commissionCents: 5340,
      commissionGstCents: 697,
      netCents: 21360,
    });
    expect(earnings.body.summary.lifetimeCents).toBe(21360);
    expect(earnings.body.summary.upcomingPayoutsCents).toBe(21360);
    expect(earnings.body.months).toHaveLength(12);
    expect(
      earnings.body.months.reduce((sum: number, month: { netCents: number }) => sum + month.netCents, 0),
    ).toBe(21360);

    const start = booking.startAt;
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' })
      .format(start)
      .slice(0, 7);
    const statement = await agent.get('/api/v1/host/earnings/statement').query({ period: month });
    expect(statement.headers['content-type']).toMatch(/text\/csv/);
    expect(statement.headers['content-disposition']).toContain(`rento-vroom-earnings-${month}.csv`);
    expect(statement.text).toContain(
      `${booking.ref},2021 Toyota Corolla,CONFIRMED,267.00,34.83,0.00,0.00,0.00,0.00,0.00,53.40,6.97,0.00,0.00,213.60`,
    );
    expect(statement.text).toMatch(/Total,,,,267\.00/);

    expect((await agent.get('/api/v1/host/earnings/statement').query({ period: 'soon' })).status).toBe(400);
  });
});
