import mongoose from 'mongoose';
import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { tripExtraChargesJob } from '../src/jobs/handlers/payout-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
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
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const client = stripe();
const app = testApp();
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;

let transfers: Stripe.TransferCreateParams[] = [];
/** The idempotency key each transfer was sent with. */
let transferKeys: (string | undefined)[] = [];

beforeEach(() => {
  transfers = [];
  transferKeys = [];
  vi.spyOn(client.transfers, 'create').mockImplementation(async (params, options) => {
    transfers.push(params);
    transferKeys.push((options as Stripe.RequestOptions | undefined)?.idempotencyKey);
    return { id: `tr_${transfers.length}` } as Stripe.Response<Stripe.Transfer>;
  });
  // Stripe's list of the transfers made so far, as runPayout checks before making one.
  vi.spyOn(client.transfers, 'list').mockImplementation(((params?: Stripe.TransferListParams) =>
    Promise.resolve({
      data: transfers
        .map((transfer, index) => ({ ...transfer, id: `tr_${index + 1}`, reversed: false }))
        .filter((transfer) => transfer.transfer_group === params?.transfer_group),
    })) as unknown as typeof client.transfers.list);
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

  it('try again with a new key after Stripe refuses one, and never pay a transfer twice', async () => {
    const { booking, payout, host } = await trip();
    await checkIn(booking._id, host._id);
    vi.mocked(client.transfers.create).mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'Your destination account needs to have at least one of the following capabilities enabled',
        statusCode: 400,
      }),
    );
    await expect(runPayout(payout.id)).rejects.toThrow(/capabilities/);
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'FAILED', transferAttempts: 1 });

    // Stripe would replay the refusal for the first key, so the retry sends a new one.
    expect(await runPayout(payout.id)).toBe('paid');
    expect(transferKeys).toEqual([`payout-${payout.id}-1`]);

    // A transfer that went through while the database missed it is found, not sent again.
    await PayoutModel.updateOne({ _id: payout._id }, { $set: { status: 'SCHEDULED' } });
    expect(await runPayout(payout.id)).toBe('paid');
    expect(transfers).toHaveLength(1);
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ stripeTransferId: 'tr_1' });
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
    // Stripe rejects http://localhost as the business website, so a local API leaves it out.
    expect(create.mock.calls[0]![0]!.business_profile).not.toHaveProperty('url');
    await agent.post('/api/v1/host/connect/onboarding-link');
    expect(create).toHaveBeenCalledTimes(1);

    const payouts = await agent.get('/api/v1/host/payouts');
    expect(payouts.body.account).toMatchObject({ connected: true, payoutsEnabled: false });
  });
});

describe('payout setup after Stripe refused it', () => {
  const refusal = (replayed: boolean) =>
    new Stripe.errors.StripeInvalidRequestError({
      message: 'Stripe no longer recommends Accounts v1 for new Connect integrations.',
      statusCode: 400,
      headers: replayed ? { 'idempotent-replayed': 'true' } : {},
    });

  it('moves on to a new idempotency key, so a fixed refusal isn’t replayed for 24 hours', async () => {
    const host = await createHost();
    const keys: (string | undefined)[] = [];
    const create = vi.spyOn(client.accounts, 'create').mockImplementation(async (_params, options) => {
      keys.push((options as Stripe.RequestOptions | undefined)?.idempotencyKey);
      // The first try is refused; the next, an hour later, gets the earlier answer replayed for the same key.
      if (keys.length === 1) throw refusal(false);
      if (keys.at(-1) === `connect-account-${host.id}`) throw refusal(true);
      return { id: 'acct_new' } as Stripe.Response<Stripe.Account>;
    });
    vi.spyOn(client.accountLinks, 'create').mockResolvedValue({
      url: 'https://connect.stripe.com/setup/e/acct_new/abc',
    } as Stripe.Response<Stripe.AccountLink>);
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: host.email, password: PASSWORD });

    expect((await agent.post('/api/v1/host/connect/onboarding-link')).status).toBeGreaterThanOrEqual(400);
    const next = await agent.post('/api/v1/host/connect/onboarding-link');
    expect(next.status).toBe(200);
    expect(keys).toEqual([`connect-account-${host.id}`, `connect-account-${host.id}-1`]);
    expect((await UserModel.findById(host._id))!.hostProfile).toMatchObject({
      stripeAccountId: 'acct_new',
      connectRefusals: 1,
    });

    // A Host refused before this fix: Stripe replays the old answer for the old key, so it tries a new one at once.
    const earlier = await createHost('earlier.host@example.co.nz');
    keys.length = 0;
    create.mockImplementation(async (_params, options) => {
      keys.push((options as Stripe.RequestOptions | undefined)?.idempotencyKey);
      if (keys.length === 1) throw refusal(true);
      return { id: 'acct_earlier' } as Stripe.Response<Stripe.Account>;
    });
    const earlierAgent = browserAgent();
    await earlierAgent.post('/api/v1/auth/login').send({ email: earlier.email, password: PASSWORD });
    expect((await earlierAgent.post('/api/v1/host/connect/onboarding-link')).status).toBe(200);
    expect(keys).toEqual([`connect-account-${earlier.id}`, `connect-account-${earlier.id}-1`]);
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

/** Another trip for the same Host, Guest and car, which ended a week ago, with its payout due now. */
async function anotherTrip({ host, guest, vehicle }: Awaited<ReturnType<typeof trip>>) {
  const startAt = new Date(Date.now() - 10 * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { status: 'PAYMENT_PENDING', startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  const payment = await createPaymentRecord(booking);
  await withTransaction((session) => confirmBooking(booking, payment, session));
  await checkIn(booking._id, host._id);
  return {
    booking: (await BookingModel.findById(booking._id))!,
    payout: (await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' }))!,
  };
}

const feesOwed = async (hostId: unknown) =>
  (await UserModel.findById(hostId).lean())!.hostProfile!.feesOwedCents;
const refundsOwed = async (hostId: unknown) =>
  (await UserModel.findById(hostId).lean())!.hostProfile!.refundsOwed ?? [];

describe('payout deductions', () => {
  it('are reserved before the transfer, so two payouts sent at once take a fee only once', async () => {
    const first = await trip();
    await checkIn(first.booking._id, first.host._id);
    const second = await anotherTrip(first);
    await UserModel.updateOne({ _id: first.host._id }, { $set: { 'hostProfile.feesOwedCents': 2500 } });

    const outcomes = await Promise.all([runPayout(first.payout.id), runPayout(second.payout.id)]);
    expect(outcomes).toEqual(['paid', 'paid']);
    const paid = await PayoutModel.find({ hostId: first.host._id, status: 'PAID' });
    const fees = paid
      .flatMap((payout) => payout.deductions)
      .filter((deduction) => deduction.type === 'HOST_CANCELLATION_FEE');
    expect(fees).toEqual([expect.objectContaining({ amountCents: 2500, owed: true })]);
    expect(transfers.reduce((sum, transfer) => sum + transfer.amount!, 0)).toBe(2 * 21360 - 2500);
    expect(await feesOwed(first.host._id)).toBe(0);
  });

  /** A trip whose transfer failed without a clear answer from Stripe, after its deductions were reserved. */
  async function failedTransfer() {
    const parts = await trip();
    await checkIn(parts.booking._id, parts.host._id);
    await UserModel.updateOne({ _id: parts.host._id }, { $set: { 'hostProfile.feesOwedCents': 2500 } });
    vi.mocked(client.transfers.create).mockRejectedValueOnce(
      new Stripe.errors.StripeAPIError({ message: 'Stripe is having a moment', statusCode: 500 }),
    );
    await expect(runPayout(parts.payout.id)).rejects.toThrow(/moment/);
    return parts;
  }

  it('are kept when a transfer fails, so the retry sends the same amount', async () => {
    const { payout, host } = await failedTransfer();
    const failed = await PayoutModel.findById(payout._id);
    expect(failed).toMatchObject({ status: 'FAILED', deductionsReservedAt: expect.any(Date) });
    expect(failed!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_CANCELLATION_FEE', amountCents: 2500 }),
    ]);
    expect(await feesOwed(host._id)).toBe(0);

    // A fee added meanwhile waits for a later payout: the retry sends what the first try would have.
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 1000 } });
    expect(await runPayout(payout.id)).toBe('paid');
    expect(transfers.map((transfer) => transfer.amount)).toEqual([21360 - 2500]);
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'PAID', amountCents: 18860 });
    expect(await feesOwed(host._id)).toBe(1000);
  });

  it('are given back when the payout is cancelled unpaid', async () => {
    const { booking, payout, host } = await failedTransfer();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 1000 } });
    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'CANCELLED' } });
    expect(await runPayout(payout.id)).toBe('skipped');
    const cancelled = await PayoutModel.findById(payout._id);
    expect(cancelled).toMatchObject({ status: 'CANCELLED' });
    expect(cancelled!.deductions).toEqual([]);
    expect(cancelled!.deductionsReservedAt).toBeUndefined();
    expect(await feesOwed(host._id)).toBe(3500);
    expect(transfers).toHaveLength(0);
  });

  it('come back to the Host when a reserved trip payout is replaced on cancellation', async () => {
    const { booking, payout, host } = await trip();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 2500 } });
    await PayoutModel.updateOne(
      { _id: payout._id },
      {
        $set: {
          status: 'HELD',
          holdReason: 'INCIDENT',
          deductionsReservedAt: new Date(),
          deductions: [{ type: 'HOST_CANCELLATION_FEE', amountCents: 2000, owed: true }],
        },
      },
    );
    await withTransaction((session) =>
      endBooking(
        booking,
        {
          to: 'CANCELLED',
          from: ['CONFIRMED'],
          cancellation: {
            reason: 'PLATFORM',
            refundCents: 33870,
            feeCents: 0,
            hostShareCents: 0,
            hostFeeCents: 0,
          },
        },
        session,
      ),
    );
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'CANCELLED' });
    expect(await feesOwed(host._id)).toBe(4500);
  });

  it('leave a payout staff held on its MANUAL hold when a card dispute opens', async () => {
    const { payout, payment } = await trip();
    await PayoutModel.updateOne({ _id: payout._id }, { $set: { status: 'HELD', holdReason: 'MANUAL' } });
    const dispute = {
      id: 'dp_manual',
      object: 'dispute',
      payment_intent: payment.stripePaymentIntentId,
      reason: 'fraudulent',
      status: 'needs_response',
    };
    expect((await webhook('charge.dispute.created', dispute)).status).toBe(200);
    expect(await PayoutModel.findById(payout._id)).toMatchObject({ status: 'HELD', holdReason: 'MANUAL' });
  });
});

describe('Host-funded refunds', () => {
  let refundNumber = 0;

  beforeEach(() => {
    refundNumber = 0;
    vi.spyOn(client.refunds, 'create').mockImplementation(async () => {
      refundNumber += 1;
      return { id: `re_${refundNumber}`, status: 'succeeded' } as Stripe.Response<Stripe.Refund>;
    });
  });

  /** A trip already paid out to the Host, and an admin signed in to the staff portal. */
  async function paidTrip() {
    const parts = await trip();
    await checkIn(parts.booking._id, parts.host._id);
    expect(await runPayout(parts.payout.id)).toBe('paid');
    await createStaff();
    return { ...parts, admin: await staffAgent() };
  }

  const refund = (
    admin: Awaited<ReturnType<typeof staffAgent>>,
    ref: string,
    body: Record<string, unknown> = {},
  ) =>
    admin
      .post(`/api/v1/admin/bookings/${ref}/refunds`)
      .send({ amountCents: 5000, reason: 'Car was not cleaned', fundedBy: 'HOST', ...body });

  it('made before the payout come off it, a line each', async () => {
    const parts = await trip();
    await checkIn(parts.booking._id, parts.host._id);
    await createStaff();
    const admin = await staffAgent();
    const before = await admin.get(`/api/v1/admin/bookings/${parts.booking.ref}`);
    expect(before.body.tripPayoutSent).toBe(false);

    const refunded = await refund(admin, parts.booking.ref);
    expect(refunded.status).toBe(200);
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'THIS_PAYOUT' });
    expect(await refundsOwed(parts.host._id)).toEqual([]);

    expect(await runPayout(parts.payout.id)).toBe('paid');
    const paid = await PayoutModel.findById(parts.payout._id);
    expect(paid!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_FUNDED_REFUND', stripeRefundId: 're_1', amountCents: 5000 }),
    ]);
    expect(transfers[0]!.amount).toBe(21360 - 5000);
  });

  it('made after the payout come off the next one as their own line, and the Host is told', async () => {
    const parts = await paidTrip();
    const detail = await parts.admin.get(`/api/v1/admin/bookings/${parts.booking.ref}`);
    expect(detail.body.tripPayoutSent).toBe(true);

    const refunded = await refund(parts.admin, parts.booking.ref);
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'NEXT_PAYOUT', owedCents: 5000 });
    // Not a Host cancellation fee: those stay separate, and only those can be waived.
    expect(await feesOwed(parts.host._id)).toBe(0);
    expect(await refundsOwed(parts.host._id)).toEqual([
      expect.objectContaining({ stripeRefundId: 're_1', amountCents: 5000, bookingId: parts.booking._id }),
    ]);
    expect(
      await NotificationModel.countDocuments({ userId: parts.host._id, type: 'HOST_REFUND_RECOVERED' }),
    ).toBe(2);
    const audit = await AuditLogModel.findOne({ action: 'refund.issued', entityId: parts.booking.id });
    expect(audit!.after).toMatchObject({ recoverFrom: 'NEXT_PAYOUT', hostRefund: { owedCents: 5000 } });

    const host = browserAgent();
    await host.post('/api/v1/auth/login').send({ email: parts.host.email, password: PASSWORD });
    expect((await host.get('/api/v1/host/payouts')).body.account).toMatchObject({
      feesOwedCents: 0,
      refundsOwedCents: 5000,
    });

    const next = await anotherTrip(parts);
    await UserModel.updateOne({ _id: parts.host._id }, { $set: { 'hostProfile.feesOwedCents': 1500 } });
    expect(await runPayout(next.payout.id)).toBe('paid');
    expect(transfers.at(-1)!.amount).toBe(21360 - 1500 - 5000);
    expect(await refundsOwed(parts.host._id)).toEqual([]);
    expect(await feesOwed(parts.host._id)).toBe(0);

    const payouts = (await host.get('/api/v1/host/payouts')).body.payouts;
    expect(payouts.find((payout: { id: string }) => payout.id === next.payout.id).deductions).toEqual([
      { type: 'HOST_CANCELLATION_FEE', amountCents: 1500 },
      { type: 'HOST_FUNDED_REFUND', amountCents: 5000, bookingRef: parts.booking.ref },
    ]);
    // The payout email has a row for each.
    const email = await NotificationModel.findOne({
      userId: parts.host._id,
      type: 'PAYOUT_PAID',
      channel: 'EMAIL',
      dedupeKey: `PAYOUT_PAID:${next.payout.id}`,
    });
    expect((email!.payload as { props: { rows: { label: string }[] } }).props.rows).toEqual(
      expect.arrayContaining([
        { label: 'Host cancellation fee', value: '−$15.00' },
        { label: `Refund for ${parts.booking.ref}`, value: '−$50.00' },
      ]),
    );
  });

  it('can be taken back from the transfer, or from the next payout when Stripe refuses', async () => {
    const parts = await paidTrip();
    const reversal = vi
      .spyOn(client.transfers, 'createReversal')
      .mockResolvedValueOnce({ id: 'trr_1' } as Stripe.Response<Stripe.TransferReversal>);

    const reversed = await refund(parts.admin, parts.booking.ref, { recoverFrom: 'REVERSE_TRANSFER' });
    expect(reversed.body.hostRefund).toEqual({ recoveredFrom: 'REVERSE_TRANSFER', reversedCents: 5000 });
    expect(reversal).toHaveBeenCalledWith(
      'tr_1',
      expect.objectContaining({
        amount: 5000,
        metadata: expect.objectContaining({ stripeRefundId: 're_1' }),
      }),
      { idempotencyKey: 'reversal-re_1' },
    );
    expect((await PayoutModel.findById(parts.payout._id))!.reversals).toEqual([
      expect.objectContaining({ stripeReversalId: 'trr_1', amountCents: 5000, stripeRefundId: 're_1' }),
    ]);
    expect(await refundsOwed(parts.host._id)).toEqual([]);

    const host = browserAgent();
    await host.post('/api/v1/auth/login').send({ email: parts.host.email, password: PASSWORD });
    expect((await host.get(`/api/v1/bookings/${parts.booking.ref}`)).body.booking.payout).toMatchObject({
      paidCents: 21360 - 5000,
      refunds: [expect.objectContaining({ amountCents: 5000, fundedBy: 'HOST' })],
    });
    expect((await host.get('/api/v1/host/payouts')).body.payouts[0]).toMatchObject({ reversedCents: 5000 });

    reversal.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'Insufficient funds in the connected account',
        statusCode: 400,
      }),
    );
    const fallback = await refund(parts.admin, parts.booking.ref, {
      amountCents: 2000,
      recoverFrom: 'REVERSE_TRANSFER',
    });
    expect(fallback.body.hostRefund).toEqual({
      recoveredFrom: 'NEXT_PAYOUT',
      owedCents: 2000,
      note: expect.stringMatching(/Insufficient funds/),
    });
    expect(await refundsOwed(parts.host._id)).toEqual([
      expect.objectContaining({ stripeRefundId: 're_2', amountCents: 2000 }),
    ]);
    const audit = await AuditLogModel.findOne({ action: 'refund.issued', 'after.amountCents': 2000 });
    expect(audit!.after).toMatchObject({
      recoverFrom: 'REVERSE_TRANSFER',
      hostRefund: { recoveredFrom: 'NEXT_PAYOUT', note: expect.stringMatching(/next payout/) },
    });
  });

  it('that fail are no longer owed, and staff are told what the Host already paid', async () => {
    const parts = await paidTrip();
    // The first is taken off the next payout; the second still waits when both fail.
    await refund(parts.admin, parts.booking.ref);
    const next = await anotherTrip(parts);
    expect(await runPayout(next.payout.id)).toBe('paid');
    await refund(parts.admin, parts.booking.ref, { amountCents: 3000 });
    expect(await refundsOwed(parts.host._id)).toEqual([
      expect.objectContaining({ stripeRefundId: 're_2', amountCents: 3000 }),
    ]);

    for (const id of ['re_1', 're_2']) {
      const failed = await webhook('refund.failed', {
        id,
        object: 'refund',
        status: 'failed',
        failure_reason: 'expired_or_canceled_card',
      });
      expect(failed.status).toBe(200);
    }
    expect(await refundsOwed(parts.host._id)).toEqual([]);
    const alerts = await NotificationModel.find({ type: 'REFUND_FAILED', channel: 'IN_APP' });
    const bodies = alerts.map((alert) => (alert.payload as { body: string }).body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /already paid for it \(\$50\.00 taken off a payout\): please return that to the Host/,
        ),
        expect.stringMatching(/The Host funded it: it no longer comes off their next payout/),
      ]),
    );
  });
});

describe('earnings with extra charges', () => {
  it('use the commission the extra charge’s payout was made with', async () => {
    const { host, booking } = await trip();
    const chargeId = new mongoose.Types.ObjectId();
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $push: {
          extraCharges: {
            _id: chargeId,
            type: 'EXTRA_KM',
            description: '50 extra km',
            amountCents: 1750,
            status: 'SUCCEEDED',
          },
        },
      },
    );
    // Made when the commission was lower than today's 20 %.
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'EXTRA_CHARGE',
      extraChargeId: chargeId,
      amountCents: 1450,
      grossCents: 1750,
      commissionCents: 300,
      commissionGstCents: 39,
      status: 'PAID',
      scheduledFor: new Date(),
      paidAt: new Date(),
    });
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: host.email, password: PASSWORD });
    const earnings = await agent.get('/api/v1/host/earnings');
    expect(earnings.body.bookings[0]).toMatchObject({
      extraChargesCents: 1750,
      commissionCents: 5340 + 300,
      netCents: 21360 + 1450,
    });
  });
});
