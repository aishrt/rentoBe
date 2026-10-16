import mongoose from 'mongoose';
import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import { refundUnwantedJob } from '../src/jobs/handlers/booking-jobs.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { JobModel } from '../src/jobs/job.model.js';
import { forget } from '../src/lib/memo.js';
import { getPlatformSettings } from '../src/modules/admin/platform-settings.service.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { confirmBooking } from '../src/modules/bookings/booking-transitions.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { runPayout } from '../src/modules/payouts/payouts.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

/*
 * Money edge cases a review of the payment fixes found (plan §8.1, items 11 and 14–16; §8.2): a trip's payout
 * already sent when the trip is cancelled as a Guest no-show, a kept fee after an earlier Host-funded refund,
 * a booking with a second payment, an extra charge Stripe took as staff cancelled it, and a Host accepting
 * again after a capture that didn't go through.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const client = stripe();
const app = testApp();
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;
type Agent = ReturnType<typeof browserAgent>;

const FLEXIBLE = {
  code: 'FLEXIBLE',
  name: 'Flexible',
  summary: 'Full refund up to 24 hours before pickup, then 50%.',
  refunds: [
    { minHoursBefore: 24, refundPct: 100 },
    { minHoursBefore: 0, refundPct: 50 },
  ],
};

/** What Stripe says a PaymentIntent is doing when asked. */
let intentStatus: Stripe.PaymentIntent.Status = 'succeeded';
let refundCount = 0;
/** Runs while a transfer is being made, as something else happening at that moment. */
let duringTransfer: (() => Promise<void>) | undefined;

function intent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.Response<Stripe.PaymentIntent> {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    amount: 33_870,
    currency: 'nzd',
    status: intentStatus,
    metadata: {},
    latest_charge: 'ch_1',
    payment_method: 'pm_saved',
    last_payment_error: null,
    ...overrides,
  } as unknown as Stripe.Response<Stripe.PaymentIntent>;
}

/** Stripe refusing to cancel a PaymentIntent that's already final. */
const cannotCancel = () =>
  new Stripe.errors.StripeInvalidRequestError({
    type: 'invalid_request_error',
    message: 'You cannot cancel this PaymentIntent because it has a status of succeeded.',
  });

beforeEach(() => {
  forget();
  intentStatus = 'succeeded';
  refundCount = 0;
  duringTransfer = undefined;
  vi.spyOn(client.paymentIntents, 'retrieve').mockImplementation(async (id) => intent({ id: String(id) }));
  vi.spyOn(client.paymentIntents, 'capture').mockImplementation(async (id) =>
    intent({ id: String(id), status: 'succeeded' }),
  );
  vi.spyOn(client.paymentIntents, 'cancel').mockImplementation(async (id) =>
    intent({ id: String(id), status: 'canceled' }),
  );
  vi.spyOn(client.refunds, 'create').mockImplementation(async (params) => {
    refundCount += 1;
    return {
      id: `re_${refundCount}`,
      status: 'succeeded',
      amount: params?.amount,
    } as Stripe.Response<Stripe.Refund>;
  });
  vi.spyOn(client.transfers, 'create').mockImplementation(async () => {
    await duringTransfer?.();
    return { id: 'tr_1' } as Stripe.Response<Stripe.Transfer>;
  });
  vi.spyOn(client.transfers, 'list').mockImplementation((() =>
    Promise.resolve({ data: [] })) as unknown as typeof client.transfers.list);
  vi.spyOn(client.customers, 'create').mockResolvedValue({ id: 'cus_1' } as Stripe.Response<Stripe.Customer>);
  vi.spyOn(client.paymentIntents, 'create').mockRejectedValue(new Error('No PaymentIntent is made here'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function webhook(type: string, object: object) {
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
    .set(
      'Stripe-Signature',
      Stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET! }),
    )
    .send(payload);
}

async function signIn(email: string): Promise<Agent> {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A Host with payouts set up, a Guest, and their car. */
async function parties() {
  const host = await createHost();
  await UserModel.updateOne(
    { _id: host._id },
    { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_host' } },
  );
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  return { host, guest, ids: { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id } };
}

/** A confirmed booking under the Flexible policy, with its trip payout scheduled. */
async function confirmed(startAt: Date) {
  const people = await parties();
  const booking = await createBookingRecord(people.ids, {
    status: 'PAYMENT_PENDING',
    startAt,
    endAt: new Date(startAt.getTime() + 3 * DAY_MS),
    cancellationPolicy: 'FLEXIBLE',
    cancellationTerms: FLEXIBLE,
  });
  const payment = await createPaymentRecord(booking);
  await withTransaction((session) => confirmBooking(booking, payment, session));
  const payout = (await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' }))!;
  return { ...people, booking: (await BookingModel.findById(booking._id))!, payment, payout };
}

/** A trip that started 30 hours ago with the Host's check-in alone: the Guest may never have turned up. */
async function hostCheckedIn() {
  const parts = await confirmed(new Date(Date.now() - 30 * HOUR_MS));
  await BookingModel.updateOne({ _id: parts.booking._id }, { $set: { status: 'ACTIVE' } });
  await ConditionReportModel.create({
    bookingId: parts.booking._id,
    stage: 'CHECK_IN',
    submittedBy: parts.host._id,
    odometer: 45_000,
    fuelOrBatteryPct: 80,
    photos: [],
    confirmedByHostAt: new Date(parts.booking.startAt.getTime() - HOUR_MS),
  });
  await createStaff();
  return { ...parts, admin: await staffAgent() };
}

const owedFor = async (hostId: unknown, key: string) =>
  (await UserModel.findById(hostId).lean())!.hostProfile!.refundsOwed?.find(
    (owed) => owed.stripeRefundId === key,
  )?.amountCents;

describe('a Guest no-show cancelled after the trip’s payout was sent (plan §8.1, items 15 and 16)', () => {
  it('settles the payout already sent against the Host’s share, instead of paying them twice', async () => {
    const { booking, payout, host, admin } = await hostCheckedIn();
    expect(await runPayout(payout.id)).toBe('paid');

    const preview = await admin
      .get(`/api/v1/admin/bookings/${booking.ref}/cancellation-preview`)
      .query({ reason: 'GUEST_NO_SHOW' });
    expect(preview.body.allowed).toBe(true);
    const share = preview.body.hostShareCents as number;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(21_360);
    expect(preview.body.message).toMatch(/trip payout of \$213\.60 was already sent/);

    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived; the host checked the car in' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.status).toBe('CANCELLED');

    // No second payout: the trip's stays paid, and the Host owes back what it sent beyond their share.
    expect(await PayoutModel.countDocuments({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toBe(0);
    expect((await PayoutModel.findById(payout._id).lean())!.status).toBe('PAID');
    expect(await owedFor(host._id, `trip-payout-${payout.id}`)).toBe(21_360 - share);
    const told = await NotificationModel.findOne({ userId: host._id, channel: 'IN_APP' })
      .sort({ createdAt: -1 })
      .lean();
    expect((told!.payload as { body: string }).body).toMatch(/already sent.*comes off your next payout/);
  });

  it('waits while the trip’s payout is being sent', async () => {
    const { booking, payout, admin } = await hostCheckedIn();
    await PayoutModel.updateOne({ _id: payout._id }, { $set: { deductionsReservedAt: new Date() } });

    const refused = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PAYOUT_IN_FLIGHT');
    expect(client.refunds.create).not.toHaveBeenCalled();
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('ACTIVE');
  });

  it('records a transfer that went out as its payout was cancelled, and the Host owes it back', async () => {
    const { booking, payout, host } = await hostCheckedIn();
    // The booking is cancelled while the transfer is being made.
    duringTransfer = async () => {
      await PayoutModel.updateOne({ _id: payout._id }, { $set: { status: 'CANCELLED', deductions: [] } });
    };

    expect(await runPayout(payout.id)).toBe('paid');
    expect(await PayoutModel.findById(payout._id).lean()).toMatchObject({
      status: 'PAID',
      stripeTransferId: 'tr_1',
      deductions: [],
    });
    expect(await owedFor(host._id, `trip-payout-${payout.id}`)).toBe(21_360);
    const alert = await NotificationModel.findOne({ type: 'PAYOUT_SENT_AFTER_CANCEL' }).lean();
    expect((alert!.payload as { title: string }).title).toBe(
      `A cancelled payout for ${booking.ref} was sent`,
    );
  });
});

describe('a cancellation after a Host-funded refund (plan §8.1, items 10 and 15)', () => {
  it('leaves the Host neither a share nor a debt once the Guest has everything back', async () => {
    // Within 24 hours of the start: the Flexible policy gives half back.
    const { booking, payment, payout, guest, host } = await confirmed(new Date(Date.now() + 12 * HOUR_MS));
    const agent = await signIn(guest.email);
    // The policy's share: the setting's part of the $133.50 rental kept, less the 20% commission.
    const { guestCancellationHostSharePct } = (await getPlatformSettings()).cancellation;
    const policyShare = Math.round(((13_350 * guestCancellationHostSharePct) / 100) * 0.8);
    expect(policyShare).toBeGreaterThan(0);

    // Staff gave $200 back, funded by the Host: their part of it is $160.
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        $set: { status: 'PARTIALLY_REFUNDED' },
        $push: {
          refunds: {
            amountCents: 20_000,
            hostCents: 16_000,
            reason: 'The car wasn’t clean',
            kind: 'STAFF',
            fundedBy: 'HOST',
            stripeRefundId: 're_staff',
            status: 'SUCCEEDED',
            createdAt: new Date(),
          },
        },
      },
    );

    const cancelled = await agent.post(`/api/v1/bookings/${booking.ref}/cancel`);
    expect(cancelled.status).toBe(200);
    // The policy's refund, up to the $138.70 left: the Guest has all $338.70 back, so nothing is kept.
    expect(cancelled.body.booking.cancellation).toMatchObject({ refundCents: 13_870, feeCents: 0 });
    // $53.15 of the $200 the policy would have given back anyway: the Host's part of the rest ($117.48) covers
    // their whole share of the kept fee, so the two cancel out instead of leaving the Host below nothing.
    expect((await BookingModel.findById(booking._id).lean())!.hostShareCents).toBe(0);
    expect((await PayoutModel.findById(payout._id).lean())!.status).toBe('CANCELLED');
    expect(await PayoutModel.exists({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toBeNull();
    expect(await owedFor(host._id, 're_staff')).toBeUndefined();
    expect((await PaymentModel.findById(payment._id).lean())!.refunds[0]).toMatchObject({
      hostCents: 0,
      hostReliefCents: 16_000,
    });
  });

  it('settles a paid trip payout with what the Host no longer pays for an earlier refund', async () => {
    // Checked in, and its payout sent, but still confirmed: staff can cancel it as a platform cancellation.
    const { booking, payment, payout, host } = await confirmed(new Date(Date.now() - 30 * HOUR_MS));
    await ConditionReportModel.create({
      bookingId: booking._id,
      stage: 'CHECK_IN',
      submittedBy: host._id,
      odometer: 45_000,
      fuelOrBatteryPct: 80,
      photos: [],
    });
    expect(await runPayout(payout.id)).toBe('paid');
    await createStaff();
    const admin = await staffAgent();
    // Refunded after the payout went: the Host's $40 share is owed off their next payout.
    vi.mocked(client.refunds.create).mockResolvedValueOnce({
      id: 're_late',
      status: 'succeeded',
    } as Stripe.Response<Stripe.Refund>);
    const refunded = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'The car wasn’t clean', fundedBy: 'HOST' });
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'NEXT_PAYOUT', owedCents: 4_000 });

    // A platform cancellation gives the Guest the rest: the Host keeps nothing of the $213.60 sent, and owes
    // back $173.60 of it, as the $40 already owed for the refund settles the rest.
    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'PLATFORM', note: 'The car was unsafe' });
    expect(cancelled.status).toBe(200);
    expect(await owedFor(host._id, `trip-payout-${payout.id}`)).toBe(21_360 - 4_000);
    expect(await owedFor(host._id, 're_late')).toBe(4_000);
    expect((await PaymentModel.findById(payment._id).lean())!.refunds[0]).toMatchObject({
      hostCents: 0,
      hostReliefCents: 4_000,
    });
  });
});

describe('a cancellation while the trip’s payout failed without a clear answer (plan §8.1, item 16)', () => {
  /** A trip under way whose transfer timed out after its deductions were reserved. */
  async function timedOut() {
    const parts = await hostCheckedIn();
    vi.mocked(client.transfers.create).mockRejectedValueOnce(
      new Stripe.errors.StripeAPIError({ message: 'Stripe is having a moment', statusCode: 500 }),
    );
    await expect(runPayout(parts.payout.id)).rejects.toThrow(/moment/);
    expect((await PayoutModel.findById(parts.payout._id).lean())!.status).toBe('FAILED');
    return parts;
  }

  it('records the transfer Stripe made after all, and settles it like a payout already sent', async () => {
    const { booking, payout, host, admin } = await timedOut();
    // The transfer went through at Stripe all the same.
    vi.mocked(client.transfers.list).mockImplementation((() =>
      Promise.resolve({
        data: [{ id: 'tr_late', metadata: { payoutId: payout.id }, reversed: false }],
      })) as unknown as typeof client.transfers.list);

    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived' });
    expect(cancelled.status).toBe(200);
    expect(await PayoutModel.findById(payout._id).lean()).toMatchObject({
      status: 'PAID',
      stripeTransferId: 'tr_late',
      amountCents: 21_360,
    });
    // No second payout: the Host keeps their share of the kept fee from the one sent, and owes the rest.
    expect(await PayoutModel.exists({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toBeNull();
    const share = (await BookingModel.findById(booking._id).lean())!.hostShareCents!;
    expect(await owedFor(host._id, `trip-payout-${payout.id}`)).toBe(21_360 - share);
  });

  it('cancels one that wasn’t sent, and a retry already under way waits for it', async () => {
    const { booking, payout, host, admin } = await timedOut();
    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived' });
    expect(cancelled.status).toBe(200);
    // Cancelled, its reservation given back, and the kept fee's share paid instead.
    expect(await PayoutModel.findById(payout._id).lean()).toMatchObject({
      status: 'CANCELLED',
      deductions: [],
    });
    expect(await PayoutModel.exists({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toBeTruthy();
    // A retry finds it cancelled and sends nothing.
    expect(await runPayout(payout.id)).toBe('skipped');
    expect(client.transfers.create).toHaveBeenCalledTimes(1);
    expect(await owedFor(host._id, `trip-payout-${payout.id}`)).toBeUndefined();
  });

  it('waits while a retry is sending it', async () => {
    const { booking, payout, admin } = await timedOut();
    // The retry is mid-transfer as staff cancel: it's being sent again.
    duringTransfer = async () => {
      const refused = await admin
        .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
        .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('PAYOUT_IN_FLIGHT');
    };
    expect(await runPayout(payout.id)).toBe('paid');
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('ACTIVE');
  });
});

describe('a booking with a second payment (plan §8.1)', () => {
  it('isn’t started while the first can’t be stopped, because Stripe can’t be reached', async () => {
    const { ids, guest } = await parties();
    await UserModel.updateOne(
      { _id: guest._id },
      {
        $set: {
          phone: '+64221112222',
          phoneVerifiedAt: new Date(),
          emailVerifiedAt: new Date(),
          identityVerification: { status: 'APPROVED', verifiedAt: new Date() },
        },
      },
    );
    const agent = await signIn(guest.email);
    const saved = await agent.put('/api/v1/me/driver-licence').send({
      number: 'AB123456',
      version: '123',
      class: 'NZ_FULL',
      issuedAt: '2012-05-01',
      expiry: '2034-05-01',
      dob: '1990-04-21',
    });
    expect(saved.body.problems).toEqual([]);
    await UserModel.updateOne({ _id: guest._id }, { $set: { 'driverLicence.status': 'APPROVED' } });
    const booking = await createBookingRecord(ids, {
      status: 'PAYMENT_PENDING',
      holdExpiresAt: new Date(Date.now() + 20 * MINUTE_MS),
    });
    // Started while the Guest's check was in review (authorise only); it has passed since (charge now).
    const first = await createPaymentRecord(booking, { status: 'PENDING' });
    intentStatus = 'requires_payment_method';
    vi.mocked(client.paymentIntents.retrieve).mockImplementation(async (id) =>
      intent({ id: String(id), capture_method: 'manual' }),
    );
    vi.mocked(client.paymentIntents.cancel).mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: 'Connection to Stripe failed' }),
    );

    const again = await agent
      .post(`/api/v1/bookings/${booking.ref}/payment`)
      .send({ acceptGuestAgreement: true });
    expect(again.status).toBe(503);
    expect(again.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    expect(client.paymentIntents.create).not.toHaveBeenCalled();
    expect((await PaymentModel.findById(first._id).lean())!.status).toBe('PENDING');
  });

  /** A booking a first payment confirmed, and a newer second one (a repeat checkout) that ended as given. */
  async function twoPayments(second: { status: 'CANCELLED' | 'REFUNDED' }) {
    const { ids, guest } = await parties();
    const booking = await createBookingRecord(ids, {
      cancellationPolicy: 'FLEXIBLE',
      cancellationTerms: FLEXIBLE,
    });
    const first = await createPaymentRecord(booking);
    const duplicate = await createPaymentRecord(booking, {
      ...second,
      ...(second.status === 'REFUNDED' && {
        refunds: [
          {
            amountCents: 33_870,
            reason: 'A second payment',
            kind: 'STAFF',
            fundedBy: 'PLATFORM',
            stripeRefundId: 're_duplicate',
            status: 'SUCCEEDED',
            createdAt: new Date(),
          },
        ],
      }),
    });
    await PaymentModel.collection.updateOne(
      { _id: duplicate._id },
      { $set: { createdAt: new Date(Date.now() + MINUTE_MS) } },
    );
    return { booking, first, agent: await signIn(guest.email) };
  }

  it.each(['CANCELLED', 'REFUNDED'] as const)(
    'is cancelled and refunded from the payment that made it, when the newer one is %s',
    async (status) => {
      const { booking, first, agent } = await twoPayments({ status });
      const cancelled = await agent.post(`/api/v1/bookings/${booking.ref}/cancel`);
      expect(cancelled.status).toBe(200);
      // More than 24 hours before the start: all of it back.
      expect(cancelled.body.booking.cancellation).toMatchObject({ refundCents: 33_870 });
      expect(client.refunds.create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: first.stripePaymentIntentId, amount: 33_870 }),
        expect.anything(),
      );
      expect((await PaymentModel.findById(first._id).lean())!.status).toBe('REFUNDED');
    },
  );

  it('releases every card hold when the Host declines the request', async () => {
    const { ids, host } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() + 5 * HOUR_MS),
    });
    const held = await createPaymentRecord(booking, { status: 'AUTHORISED' });
    const again = await createPaymentRecord(booking, { status: 'PENDING' });
    await PaymentModel.collection.updateOne(
      { _id: again._id },
      { $set: { createdAt: new Date(Date.now() + MINUTE_MS) } },
    );
    const hostAgent = await signIn(host.email);

    const declined = await hostAgent.post(`/api/v1/bookings/${booking.ref}/decline`).send({});
    expect(declined.status).toBe(200);
    expect(declined.body.booking.status).toBe('DECLINED');
    for (const payment of [held, again]) {
      expect(client.paymentIntents.cancel).toHaveBeenCalledWith(
        payment.stripePaymentIntentId,
        {},
        expect.anything(),
      );
      expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('CANCELLED');
    }
  });
});

describe('an extra charge Stripe took as staff cancelled it (plan §8.1, item 11)', () => {
  it('is refunded in full, funded by the platform, and staff are told', async () => {
    const { ids, guest } = await parties();
    await createStaff();
    const startAt = new Date(Date.now() - 5 * DAY_MS);
    const booking = await createBookingRecord(ids, {
      status: 'COMPLETED',
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
    });
    await createPaymentRecord(booking);
    const chargeId = new mongoose.Types.ObjectId();
    // Cancelled by staff while its collection was running: its payment was recorded as cancelled.
    const payment = await PaymentModel.create({
      bookingId: booking._id,
      type: 'EXTRA_CHARGE',
      extraChargeId: chargeId,
      stripePaymentIntentId: 'pi_extra_late',
      amountCents: 6_000,
      status: 'CANCELLED',
    });
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          extraCharges: [
            {
              _id: chargeId,
              type: 'CLEANING',
              description: 'Sand through the back seats',
              amountCents: 6_000,
              status: 'CANCELLED',
              paymentId: payment._id,
            },
          ],
        },
      },
    );

    const paid = { id: 'pi_extra_late', object: 'payment_intent', status: 'succeeded', amount: 6_000 };
    expect((await webhook('payment_intent.succeeded', paid)).status).toBe(200);
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('SUCCEEDED');
    // The charge stays cancelled, and the Host isn't paid for it.
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges[0]!.status).toBe('CANCELLED');
    expect(await PayoutModel.exists({ bookingId: booking._id, type: 'EXTRA_CHARGE' })).toBeNull();
    expect(await NotificationModel.exists({ type: 'EXTRA_CHARGE_TAKEN_AFTER_CANCEL' })).not.toBeNull();
    const job = (await JobModel.findOne({ type: 'payment.refundUnwanted' }).lean())!.payload as {
      paymentId: string;
      reason: 'CHARGE_CANCELLED';
    };
    expect(job).toEqual({ paymentId: payment.id, reason: 'CHARGE_CANCELLED' });

    await refundUnwantedJob(job, context);
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_extra_late', amount: 6_000 }),
      expect.anything(),
    );
    expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
      status: 'REFUNDED',
      refunds: [expect.objectContaining({ amountCents: 6_000, fundedBy: 'PLATFORM', kind: 'STAFF' })],
    });
    expect(
      await NotificationModel.exists({ userId: guest._id, type: 'REFUND_ISSUED', channel: 'IN_APP' }),
    ).not.toBeNull();
    // By email too: the Guest's last email about it said there was nothing to pay.
    const email = await NotificationModel.findOne({
      userId: guest._id,
      type: 'REFUND_ISSUED',
      channel: 'EMAIL',
    }).lean();
    expect(email!.payload).toMatchObject({
      template: 'tripNotice',
      props: { heading: '$60.00 refunded: the charge was cancelled' },
    });
    // Run again (a retry): nothing more.
    await refundUnwantedJob(job, context);
    expect(client.refunds.create).toHaveBeenCalledTimes(1);
  });
});

describe('a Host accepting a request again (plan §8.1, item 14)', () => {
  it('captures the payment when Stripe couldn’t be reached the first time', async () => {
    const { ids, host } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() + 5 * HOUR_MS),
      // Accepted already, while support checked the Guest; then the capture didn't go through.
      hostAcceptedAt: new Date(Date.now() - 10 * MINUTE_MS),
      verificationReview: { status: 'APPROVED' },
    });
    const payment = await createPaymentRecord(booking, { status: 'AUTHORISED' });
    const hostAgent = await signIn(host.email);

    const accepted = await hostAgent.post(`/api/v1/bookings/${booking.ref}/accept`);
    expect(accepted.status).toBe(200);
    expect(client.paymentIntents.capture).toHaveBeenCalledWith(
      payment.stripePaymentIntentId,
      {},
      expect.anything(),
    );
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');
  });

  it('answers with the booking confirmed when its capture went through just as the trip started', async () => {
    const { ids, host } = await parties();
    const startAt = new Date(Date.now() - HOUR_MS);
    const booking = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      requestExpiresAt: new Date(Date.now() + 5 * HOUR_MS),
    });
    await createPaymentRecord(booking, { status: 'AUTHORISED' });
    // Stripe had captured it already, so it can't be released.
    vi.mocked(client.paymentIntents.cancel).mockRejectedValueOnce(cannotCancel());
    const hostAgent = await signIn(host.email);

    const accepted = await hostAgent.post(`/api/v1/bookings/${booking.ref}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.booking.status).toBe('CONFIRMED');
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');
  });
});
