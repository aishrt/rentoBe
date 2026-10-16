import mongoose from 'mongoose';
import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import { refundUnwantedJob, syncRefundsJob } from '../src/jobs/handlers/booking-jobs.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { startCheckJob } from '../src/jobs/handlers/trip-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { forget } from '../src/lib/memo.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import {
  expirePaymentHold,
  expireRequest,
  resolveVerificationReview,
} from '../src/modules/bookings/booking.service.js';
import { markRequested } from '../src/modules/bookings/booking-transitions.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { StripeEventModel } from '../src/modules/payments/stripe-event.model.js';
import { stripeEventHandlers } from '../src/modules/payments/stripe-webhook.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle, nzDay } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

/*
 * Races and edge cases around money (plan §8.1, items 13–21; §8.2): a payment Stripe took while its booking was
 * ending, a second payment for one booking, failed refunds, refunded and cancelled extra charges, disputes,
 * refunds made before a cancellation, requests that run into their start time, Guest no-shows after a Host's
 * check-in, webhook duplicate keys and refunds made outside the app.
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
let intentStatus: Stripe.PaymentIntent.Status = 'requires_payment_method';
let intentCount = 0;
let refundCount = 0;

function intent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.Response<Stripe.PaymentIntent> {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    client_secret: 'pi_1_secret',
    amount: 33_870,
    currency: 'nzd',
    status: intentStatus,
    metadata: {},
    latest_charge: 'ch_1',
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
  intentStatus = 'requires_payment_method';
  intentCount = 0;
  refundCount = 0;
  const captureMethods = new Map<string, Stripe.PaymentIntent.CaptureMethod>();
  vi.spyOn(client.customers, 'create').mockResolvedValue({ id: 'cus_1' } as Stripe.Response<Stripe.Customer>);
  vi.spyOn(client.customerSessions, 'create').mockResolvedValue({
    client_secret: 'cuss_secret',
  } as Stripe.Response<Stripe.CustomerSession>);
  vi.spyOn(client.paymentIntents, 'create').mockImplementation(async (params) => {
    intentCount += 1;
    const captureMethod = params.capture_method ?? 'automatic';
    captureMethods.set(`pi_${intentCount}`, captureMethod);
    return intent({
      id: `pi_${intentCount}`,
      client_secret: `pi_${intentCount}_secret`,
      amount: params.amount,
      capture_method: captureMethod,
    });
  });
  vi.spyOn(client.paymentIntents, 'retrieve').mockImplementation(async (id) =>
    intent({ id: String(id), capture_method: captureMethods.get(String(id)) ?? 'automatic' }),
  );
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

const inApp = (type: string) => NotificationModel.findOne({ type, channel: 'IN_APP' }).lean();
const jobOf = async (type: string) =>
  (await JobModel.findOne({ type }).lean())?.payload as Record<string, unknown>;

// Booking through the API -------------------------------------------------------------------------------------

async function readyGuest(email = 'kiri@example.co.nz') {
  const guest = await createUser({ email, firstName: 'Kiri' });
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
  const agent = await signIn(email);
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
  return { guest, agent };
}

/** A booking at the payment step: its PaymentIntent is made, and Stripe.js is confirming it. */
async function checkout(instantBook = true) {
  const host = await createHost();
  await UserModel.updateOne(
    { _id: host._id },
    { $set: { phone: '+64211234567', phoneVerifiedAt: new Date() } },
  );
  const vehicle = await createVehicle(host._id, {
    rules: {
      minDays: 1,
      maxDays: 30,
      minNoticeHours: 4,
      bufferHours: 2,
      instantBook,
      cancellationTier: 'MODERATE',
    },
  });
  const { guest, agent } = await readyGuest();
  const created = await agent
    .post('/api/v1/bookings')
    .send({ vehicleId: vehicle.id, start: nzDay(10), end: nzDay(13) });
  expect(created.status).toBe(201);
  const id = created.body.booking.id as string;
  const prepared = await agent.post(`/api/v1/bookings/${id}/payment`).send({ acceptGuestAgreement: true });
  expect(prepared.status).toBe(200);
  const payment = (await PaymentModel.findOne({ bookingId: id }).lean())!;
  return {
    host,
    guest,
    agent,
    hostAgent: await signIn(host.email),
    id,
    ref: created.body.booking.ref as string,
    piId: payment.stripePaymentIntentId,
  };
}

/** A request whose card is authorised, waiting for the Host. */
async function authorisedRequest() {
  const booked = await checkout(false);
  const authorised = {
    id: booked.piId,
    object: 'payment_intent',
    status: 'requires_capture',
    amount: 33_870,
  };
  expect((await webhook('payment_intent.amount_capturable_updated', authorised)).status).toBe(200);
  expect((await BookingModel.findById(booked.id).lean())!.status).toBe('PENDING');
  return booked;
}

// Bookings written straight to the database -------------------------------------------------------------------

async function parties() {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  return { host, guest, vehicle, ids: { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id } };
}

describe('a payment Stripe takes while its booking is ending (plan §8.1, item 14)', () => {
  it('confirms a request the Guest withdraws as the Host accepts, and tells the Guest', async () => {
    const { agent, ref, id, piId } = await authorisedRequest();
    // The Host's capture went through a moment before the Guest's withdrawal reached Stripe.
    intentStatus = 'succeeded';
    vi.mocked(client.paymentIntents.cancel).mockRejectedValueOnce(cannotCancel());

    const withdrawn = await agent.post(`/api/v1/bookings/${ref}/cancel`);
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error.code).toBe('ALREADY_CHANGED');
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
    expect((await PaymentModel.findOne({ stripePaymentIntentId: piId }).lean())!.status).toBe('SUCCEEDED');
    expect(client.refunds.create).not.toHaveBeenCalled();
  });

  it('confirms instead of expiring a request whose capture went through as its 24 h ran out', async () => {
    const { id, piId } = await authorisedRequest();
    intentStatus = 'succeeded';
    vi.mocked(client.paymentIntents.cancel).mockRejectedValueOnce(cannotCancel());

    expect(await expireRequest(id, new Date(Date.now() + 25 * HOUR_MS))).toBe(false);
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
    expect((await PaymentModel.findOne({ stripePaymentIntentId: piId }).lean())!.status).toBe('SUCCEEDED');
  });

  it('never marks a payment already taken as cancelled when a request expires', async () => {
    const { ids } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() - MINUTE_MS),
    });
    // The webhook recorded the capture, but the booking still says PENDING (its job runs first).
    const payment = await createPaymentRecord(booking, { status: 'SUCCEEDED' });
    intentStatus = 'succeeded';
    vi.mocked(client.paymentIntents.cancel).mockRejectedValueOnce(cannotCancel());
    await expireRequest(booking.id);
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('SUCCEEDED');
  });

  it('applies a payment 3-D Secure finished as the 30-minute hold ran out, instead of expiring it', async () => {
    const { id, piId } = await checkout();
    // Still waiting for 3-D Secure when the job looks, paid by the time it releases the payment.
    vi.mocked(client.paymentIntents.retrieve).mockResolvedValueOnce(
      intent({ id: piId, status: 'requires_action' }),
    );
    intentStatus = 'succeeded';
    vi.mocked(client.paymentIntents.cancel).mockRejectedValueOnce(cannotCancel());

    expect(await expirePaymentHold(id, new Date(Date.now() + 31 * MINUTE_MS))).toBe('paid');
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
    expect((await PaymentModel.findOne({ stripePaymentIntentId: piId }).lean())!.status).toBe('SUCCEEDED');
  });

  it('leaves a request waiting when Stripe can’t be reached to capture it, instead of expiring it', async () => {
    const { hostAgent, ref, id, piId } = await authorisedRequest();
    vi.mocked(client.paymentIntents.capture).mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'Request timed out' }),
    );

    const accepted = await hostAgent.post(`/api/v1/bookings/${ref}/accept`);
    expect(accepted.status).toBe(503);
    expect(accepted.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    expect((await BookingModel.findById(id).lean())!.status).toBe('PENDING');
    expect((await PaymentModel.findOne({ stripePaymentIntentId: piId }).lean())!.status).toBe('AUTHORISED');
    expect(client.paymentIntents.cancel).not.toHaveBeenCalled();

    // Trying again captures it (the same idempotency key never captures twice).
    const again = await hostAgent.post(`/api/v1/bookings/${ref}/accept`);
    expect(again.status).toBe(200);
    expect(again.body.booking.status).toBe('CONFIRMED');
  });

  it('confirms a booking whose capture Stripe refused because it had already gone through', async () => {
    const { hostAgent, ref, id } = await authorisedRequest();
    vi.mocked(client.paymentIntents.capture).mockRejectedValueOnce(cannotCancel());
    intentStatus = 'succeeded';

    const accepted = await hostAgent.post(`/api/v1/bookings/${ref}/accept`);
    expect(accepted.status).toBe(200);
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
  });

  it('refunds a payment recorded as cancelled that Stripe took after its booking expired', async () => {
    const { ids } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'EXPIRED',
      statusHistory: [
        { status: 'PAYMENT_PENDING', at: new Date() },
        { status: 'EXPIRED', at: new Date() },
      ],
    });
    const payment = await createPaymentRecord(booking, { status: 'CANCELLED' });

    const paid = {
      id: payment.stripePaymentIntentId,
      object: 'payment_intent',
      status: 'succeeded',
      amount: 33_870,
    };
    expect((await webhook('payment_intent.succeeded', paid)).status).toBe(200);
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('SUCCEEDED');
    const job = (await jobOf('payment.refundUnwanted')) as { paymentId: string };
    expect(job).toEqual({ paymentId: payment.id });

    intentStatus = 'succeeded';
    await refundUnwantedJob(job, context);
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: payment.stripePaymentIntentId, amount: 33_870 }),
      { idempotencyKey: `refund-${payment.id}-unwanted` },
    );
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('REFUNDED');
  });

  it('decides what to give back from Stripe, not from the payment’s record', async () => {
    const { ids } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'EXPIRED',
      statusHistory: [
        { status: 'PAYMENT_PENDING', at: new Date() },
        { status: 'EXPIRED', at: new Date() },
      ],
    });
    // Recorded as cancelled by code that ignored Stripe's answer.
    const payment = await createPaymentRecord(booking, { status: 'CANCELLED' });

    // Stripe never took it: nothing to refund.
    intentStatus = 'canceled';
    await refundUnwantedJob({ paymentId: payment.id }, context);
    expect(client.refunds.create).not.toHaveBeenCalled();

    // Stripe took it: refunded in full.
    intentStatus = 'succeeded';
    await refundUnwantedJob({ paymentId: payment.id }, context);
    expect(client.refunds.create).toHaveBeenCalledTimes(1);
    expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
      status: 'REFUNDED',
      refunds: [expect.objectContaining({ amountCents: 33_870, kind: 'LATE_PAYMENT', fundedBy: 'PLATFORM' })],
    });
  });
});

describe('a second payment for one booking (plan §8.1)', () => {
  it('isn’t started when the first one already went through: that one is applied instead', async () => {
    const { agent, id, piId } = await checkout();
    // Paid, but the webhook hasn't arrived and the website's sync was lost.
    intentStatus = 'succeeded';

    const again = await agent.post(`/api/v1/bookings/${id}/payment`).send({ acceptGuestAgreement: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_PAID');
    expect(client.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
    expect((await PaymentModel.findOne({ stripePaymentIntentId: piId }).lean())!.status).toBe('SUCCEEDED');
  });

  it('is refunded in full when it goes through on a booking another payment confirmed, and staff are told', async () => {
    const { ids } = await parties();
    await createStaff();
    const booking = await createBookingRecord(ids);
    const first = await createPaymentRecord(booking);
    const second = await createPaymentRecord(booking, { status: 'PENDING' });

    const paid = {
      id: second.stripePaymentIntentId,
      object: 'payment_intent',
      status: 'succeeded',
      amount: 33_870,
    };
    expect((await webhook('payment_intent.succeeded', paid)).status).toBe(200);
    expect((await PaymentModel.findById(second._id).lean())!.status).toBe('SUCCEEDED');
    const job = (await jobOf('payment.refundUnwanted')) as { paymentId: string; reason: 'DUPLICATE' };
    expect(job).toEqual({ paymentId: second.id, reason: 'DUPLICATE' });
    expect(await inApp('DUPLICATE_PAYMENT')).toMatchObject({
      payload: expect.objectContaining({ title: `A second payment on ${booking.ref}` }),
    });

    intentStatus = 'succeeded';
    await refundUnwantedJob(job, context);
    expect(client.refunds.create).toHaveBeenCalledTimes(1);
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: second.stripePaymentIntentId, amount: 33_870 }),
      expect.anything(),
    );
    expect((await PaymentModel.findById(second._id).lean())!.status).toBe('REFUNDED');
    // The payment that made the booking, and the booking, stay as they were.
    expect(await PaymentModel.findById(first._id).lean()).toMatchObject({ status: 'SUCCEEDED', refunds: [] });
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');
    const told = await NotificationModel.findOne({ type: 'REFUND_ISSUED', channel: 'IN_APP' }).lean();
    expect((told!.payload as { body: string }).body).toMatch(
      /already paid for, so your second payment is refunded/,
    );
  });
});

describe('a refund that fails (plan §8.1, item 21)', () => {
  it('puts the payment back to paid, so staff can refund it another way', async () => {
    const { ids } = await parties();
    const booking = await createBookingRecord(ids);
    const payment = await createPaymentRecord(booking, {
      status: 'REFUNDED',
      refunds: [
        {
          amountCents: 33_870,
          reason: 'Cancellation',
          fundedBy: 'PLATFORM',
          stripeRefundId: 're_closed_card',
          status: 'PENDING',
          createdAt: new Date(),
        },
      ],
    });
    const failed = {
      id: 're_closed_card',
      object: 'refund',
      status: 'failed',
      failure_reason: 'expired_or_canceled_card',
    };
    expect((await webhook('refund.failed', failed)).status).toBe(200);
    expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
      status: 'SUCCEEDED',
      refunds: [expect.objectContaining({ status: 'FAILED' })],
    });
  });
});

/** A completed trip with one paid extra charge, refunded as given. */
async function refundedCharge(refundCents: number) {
  const { ids, guest } = await parties();
  const startAt = new Date(Date.now() - 5 * DAY_MS);
  const booking = await createBookingRecord(ids, {
    status: 'COMPLETED',
    startAt,
    endAt: new Date(startAt.getTime() + 3 * DAY_MS),
  });
  await createPaymentRecord(booking);
  const chargeId = new mongoose.Types.ObjectId();
  const payment = await PaymentModel.create({
    bookingId: booking._id,
    type: 'EXTRA_CHARGE',
    extraChargeId: chargeId,
    stripePaymentIntentId: `pi_extra_${chargeId.toString()}`,
    amountCents: 6_000,
    status: refundCents >= 6_000 ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    method: 'Visa ending 4242',
    refunds: [
      {
        amountCents: refundCents,
        reason: 'Cleaning wasn’t needed',
        kind: 'STAFF',
        fundedBy: 'HOST',
        stripeRefundId: 're_extra',
        status: 'SUCCEEDED',
        createdAt: new Date(),
      },
    ],
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
            status: 'SUCCEEDED',
            paymentId: payment._id,
          },
        ],
      },
    },
  );
  return { booking, payment, guest, agent: await signIn(guest.email) };
}

describe('an extra charge refunded after it was paid', () => {
  it('stays refunded when a late webhook says it succeeded', async () => {
    const { payment } = await refundedCharge(6_000);
    const paid = {
      id: payment.stripePaymentIntentId,
      object: 'payment_intent',
      status: 'succeeded',
      amount: 6_000,
    };
    expect((await webhook('payment_intent.succeeded', paid)).status).toBe(200);
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('REFUNDED');
  });

  it.each([6_000, 2_000])(
    'keeps its receipt link in the payment history once refunded (%i cents)',
    async (refundCents) => {
      const { agent, payment } = await refundedCharge(refundCents);
      const history = (await agent.get('/api/v1/me/payments')).body.payments as { id: string }[];
      expect(history.find((item) => item.id === payment.id)).toMatchObject({
        status: refundCents === 6_000 ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        hasReceipt: true,
      });
    },
  );

  it('shows as refunded on its pay link, which takes no payment', async () => {
    const { payment, agent } = await refundedCharge(6_000);
    const link = await agent.get(`/api/v1/payments/${payment.id}`);
    expect(link.body.payment).toMatchObject({ status: 'REFUNDED', refundedCents: 6_000 });
    const pay = await agent.post(`/api/v1/payments/${payment.id}/pay`);
    expect(pay.status).toBe(409);
    expect(pay.body.error.code).toBe('ALREADY_PAID');
  });

  it('shows as paid with the part refunded when only part went back', async () => {
    const { payment, agent, booking } = await refundedCharge(2_000);
    expect((await agent.get(`/api/v1/payments/${payment.id}`)).body.payment).toMatchObject({
      status: 'PAID',
      refundedCents: 2_000,
    });
    expect((await agent.get(`/api/v1/bookings/${booking.ref}`)).body.booking.extraCharges).toEqual([
      expect.objectContaining({ status: 'PAID', refundedCents: 2_000 }),
    ]);
  });

  it('shows as refunded on the trip, and its refund is on the receipt', async () => {
    const { agent, booking } = await refundedCharge(6_000);
    expect((await agent.get(`/api/v1/bookings/${booking.ref}`)).body.booking.extraCharges).toEqual([
      expect.objectContaining({ status: 'REFUNDED', refundedCents: 6_000 }),
    ]);
    const receipt = await agent.get(`/api/v1/bookings/${booking.ref}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt.extraCharges).toEqual([
      expect.objectContaining({
        description: 'Sand through the back seats',
        amountCents: 6_000,
        refundedCents: 6_000,
        refunds: [expect.objectContaining({ amountCents: 6_000, status: 'SUCCEEDED' })],
      }),
    ]);
    // The PDF lays the refund out under the charge.
    const pdf = await agent.get(`/api/v1/bookings/${booking.ref}/receipt.pdf`);
    expect(pdf.status).toBe(200);
  });
});

describe('an extra charge paid twice (plan §8.1, items 11 and 14)', () => {
  /** A cleaning charge paid with one payment, with a second payment for it still open (made before the fix). */
  async function paidCharge() {
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
    const first = await PaymentModel.create({
      bookingId: booking._id,
      type: 'EXTRA_CHARGE',
      extraChargeId: chargeId,
      stripePaymentIntentId: 'pi_extra_first',
      amountCents: 6_000,
      status: 'SUCCEEDED',
    });
    const second = await PaymentModel.create({
      bookingId: booking._id,
      type: 'EXTRA_CHARGE',
      extraChargeId: chargeId,
      stripePaymentIntentId: 'pi_extra_second',
      amountCents: 6_000,
      status: 'FAILED',
      failureReason: 'Your card was declined.',
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
              status: 'SUCCEEDED',
              paymentId: first._id,
            },
          ],
        },
      },
    );
    return { booking, first, second, agent: await signIn(guest.email) };
  }

  it('says paid on a leftover pay link, which takes no payment', async () => {
    const { second, agent } = await paidCharge();
    expect((await agent.get(`/api/v1/payments/${second.id}`)).body.payment.status).toBe('PAID');
    const pay = await agent.post(`/api/v1/payments/${second.id}/pay`);
    expect(pay.status).toBe(409);
    expect(pay.body.error.code).toBe('ALREADY_PAID');
  });

  it('refunds the second payment in full and tells staff, leaving the charge paid', async () => {
    const { booking, first, second, agent } = await paidCharge();
    const paid = { id: 'pi_extra_second', object: 'payment_intent', status: 'succeeded', amount: 6_000 };
    expect((await webhook('payment_intent.succeeded', paid)).status).toBe(200);

    expect((await PaymentModel.findById(second._id).lean())!.status).toBe('SUCCEEDED');
    // The charge stays paid by the first payment, and the Host isn't paid twice for it.
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges[0]).toMatchObject({
      status: 'SUCCEEDED',
      paymentId: first._id,
    });
    expect(await PayoutModel.countDocuments({ bookingId: booking._id, type: 'EXTRA_CHARGE' })).toBe(0);
    expect(await inApp('EXTRA_CHARGE_PAID_TWICE')).toBeTruthy();
    const job = await jobOf('payment.refundUnwanted');
    expect(job).toEqual({ paymentId: second.id, reason: 'CHARGE_DUPLICATE' });

    intentStatus = 'succeeded';
    await refundUnwantedJob(job as Parameters<typeof refundUnwantedJob>[0], context);
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: 'pi_extra_second', amount: 6_000 }),
      { idempotencyKey: `refund-${second.id}-paid-twice` },
    );
    expect(await PaymentModel.findById(second._id).lean()).toMatchObject({
      status: 'REFUNDED',
      refunds: [expect.objectContaining({ amountCents: 6_000, fundedBy: 'PLATFORM' })],
    });
    expect(await inApp('REFUND_ISSUED')).toMatchObject({
      payload: { body: expect.stringContaining('paid twice') },
    });
    // The first payment isn't given back, and the charge still shows as paid, with the paying one's receipt.
    expect((await PaymentModel.findById(first._id).lean())!.status).toBe('SUCCEEDED');
    expect((await agent.get(`/api/v1/bookings/${booking.ref}`)).body.booking.extraCharges).toEqual([
      expect.objectContaining({ status: 'PAID' }),
    ]);
    const history = (await agent.get('/api/v1/me/payments')).body.payments as {
      id: string;
      hasReceipt: boolean;
    }[];
    expect(history.find((item) => item.id === first.id)?.hasReceipt).toBe(true);
    expect(history.find((item) => item.id === second.id)?.hasReceipt).toBe(false);
  });
});

describe('staff cancelling an extra charge (plan §8.1, item 11)', () => {
  async function unpaidCharge() {
    const { ids, guest } = await parties();
    const startAt = new Date(Date.now() - 5 * DAY_MS);
    const booking = await createBookingRecord(ids, {
      status: 'COMPLETED',
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
    });
    await createPaymentRecord(booking);
    const chargeId = new mongoose.Types.ObjectId();
    const payment = await PaymentModel.create({
      bookingId: booking._id,
      type: 'EXTRA_CHARGE',
      extraChargeId: chargeId,
      stripePaymentIntentId: 'pi_extra_declined',
      amountCents: 6_000,
      status: 'FAILED',
      failureReason: 'Your card was declined.',
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
              status: 'PENDING',
              paymentId: payment._id,
            },
          ],
        },
      },
    );
    // The next try on the saved card, tomorrow.
    await JobModel.create({
      type: 'extraCharge.collect',
      payload: { bookingId: booking.id, chargeId: chargeId.toString(), attempt: 2 },
      runAt: new Date(Date.now() + DAY_MS),
      uniqueKey: `extra-charge:${chargeId.toString()}:2`,
      refId: booking.id,
    });
    return { booking, payment, chargeId: chargeId.toString(), guest };
  }

  const cancelCharge = (agent: Agent, ref: string, chargeId: string, reason = 'Charged by mistake') =>
    agent.post(`/api/v1/admin/bookings/${ref}/extra-charges/${chargeId}/cancel`).send({ reason });

  it('takes it off what the Guest owes, stops its payment and retries, and tells the Guest', async () => {
    const { booking, payment, chargeId, guest } = await unpaidCharge();
    await createStaff();
    const admin = await staffAgent();

    const cancelled = await cancelCharge(admin, booking.ref, chargeId);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.extraCharges).toEqual([expect.objectContaining({ status: 'CANCELLED' })]);
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith('pi_extra_declined', {}, expect.anything());
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('CANCELLED');
    expect((await JobModel.findOne({ type: 'extraCharge.collect' }).lean())!.status).toBe('CANCELLED');
    expect(await inApp('EXTRA_CHARGE_CANCELLED')).toMatchObject({ userId: guest._id });
    expect(
      await AuditLogModel.findOne({ action: 'booking.extra-charge-cancelled', entityId: booking.id }).lean(),
    ).toMatchObject({ after: { status: 'CANCELLED', reason: 'Charged by mistake' } });

    // The pay link says so, and takes no payment.
    const guestAgent = await signIn(guest.email);
    expect((await guestAgent.get(`/api/v1/payments/${payment.id}`)).body.payment.status).toBe('CANCELLED');
    const pay = await guestAgent.post(`/api/v1/payments/${payment.id}/pay`);
    expect(pay.status).toBe(409);
    expect(pay.body.error.code).toBe('CHARGE_CANCELLED');
    // It no longer stops the Guest closing their account, and can't be cancelled twice.
    expect(
      await BookingModel.exists({
        guestId: guest._id,
        extraCharges: { $elemMatch: { status: { $in: ['PENDING', 'FAILED'] } } },
      }),
    ).toBeNull();
    expect((await cancelCharge(admin, booking.ref, chargeId)).body.error.code).toBe('NOT_CANCELLABLE');
  });

  it('needs the refunds permission and a reason', async () => {
    const { booking, chargeId } = await unpaidCharge();
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const support = await staffAgent('mere@example.co.nz');
    expect((await cancelCharge(support, booking.ref, chargeId)).status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    expect((await cancelCharge(admin, booking.ref, chargeId, '')).status).toBe(400);
  });

  it('is refused when the Guest paid it a moment ago, which is recorded as paid', async () => {
    const { booking, chargeId, payment } = await unpaidCharge();
    await createStaff();
    const admin = await staffAgent();
    intentStatus = 'succeeded';
    vi.mocked(client.paymentIntents.cancel).mockRejectedValueOnce(cannotCancel());

    const refused = await cancelCharge(admin, booking.ref, chargeId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ALREADY_PAID');
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('SUCCEEDED');
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges[0]!.status).toBe('SUCCEEDED');
  });
});

describe('a card dispute that closes (plan §8.1, item 12)', () => {
  async function disputedTrip() {
    const { ids } = await parties();
    await createStaff();
    const booking = await createBookingRecord(ids, { startAt: new Date(Date.now() - DAY_MS) });
    const payment = await createPaymentRecord(booking);
    const payout = await PayoutModel.create({
      hostId: ids.hostId,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'HELD',
      holdReason: 'DISPUTE',
      scheduledFor: new Date(),
    });
    const dispute = (status: string) => ({
      id: 'dp_1',
      object: 'dispute',
      payment_intent: payment.stripePaymentIntentId,
      reason: 'fraudulent',
      status,
      amount: 33_870,
    });
    return { booking, payout, dispute };
  }

  it('keeps the payouts held when lost, as a staff hold, and tells staff', async () => {
    const { booking, payout, dispute } = await disputedTrip();
    expect((await webhook('charge.dispute.closed', dispute('lost'))).status).toBe(200);
    expect(await PayoutModel.findById(payout._id).lean()).toMatchObject({
      status: 'HELD',
      holdReason: 'MANUAL',
    });
    expect(await AuditLogModel.findOne({ action: 'payout.held', entityId: booking.id }).lean()).toMatchObject(
      {
        after: expect.objectContaining({ reason: 'Card dispute lost' }),
      },
    );
    expect(await inApp('CARD_DISPUTE_CLOSED')).toMatchObject({
      payload: expect.objectContaining({ title: `Card dispute lost on ${booking.ref}` }),
    });
  });

  it('releases the payouts when won, and tells staff', async () => {
    const { booking, payout, dispute } = await disputedTrip();
    expect((await webhook('charge.dispute.closed', dispute('won'))).status).toBe(200);
    expect((await PayoutModel.findById(payout._id).lean())!.status).not.toBe('HELD');
    expect(await inApp('CARD_DISPUTE_CLOSED')).toMatchObject({
      payload: expect.objectContaining({ title: `Card dispute won on ${booking.ref}` }),
    });
  });

  it('keeps the payouts held when prevented, as the money went back as for a lost one, and tells staff', async () => {
    const { booking, payout, dispute } = await disputedTrip();
    expect((await webhook('charge.dispute.closed', dispute('prevented'))).status).toBe(200);
    expect(await PayoutModel.findById(payout._id).lean()).toMatchObject({
      status: 'HELD',
      holdReason: 'MANUAL',
    });
    expect(await AuditLogModel.findOne({ action: 'payout.held', entityId: booking.id }).lean()).toMatchObject(
      { after: expect.objectContaining({ holdReason: 'MANUAL' }) },
    );
    expect(await inApp('CARD_DISPUTE_CLOSED')).toMatchObject({
      payload: expect.objectContaining({
        title: `Card dispute refunded on ${booking.ref}`,
        body: expect.stringContaining('stay on hold'),
      }),
    });
  });
});

describe('a booking whose payment is in a card dispute (plan §8.1, item 12)', () => {
  /** A confirmed trip under the Flexible policy whose payment has a chargeback, with its payout held for it. */
  async function chargedBack(status = 'needs_response', startAt = new Date(Date.now() + 10 * DAY_MS)) {
    const { ids, host, guest } = await parties();
    await createStaff();
    const booking = await createBookingRecord(ids, {
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      cancellationPolicy: 'FLEXIBLE',
      cancellationTerms: FLEXIBLE,
    });
    const payment = await createPaymentRecord(booking, {
      dispute: { stripeDisputeId: 'dp_1', reason: 'fraudulent', status },
    });
    const payout = await PayoutModel.create({
      hostId: ids.hostId,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'HELD',
      holdReason: 'DISPUTE',
      scheduledFor: new Date(startAt.getTime() + DAY_MS),
    });
    return { booking, payment, payout, host, guest };
  }

  it('can’t be cancelled by the Guest or the Host, and their dialog says why instead of offering a refund', async () => {
    const { booking, host, guest } = await chargedBack();
    for (const agent of [await signIn(guest.email), await signIn(host.email)]) {
      const preview = await agent.get(`/api/v1/bookings/${booking.ref}/cancellation-preview`);
      expect(preview.body).toMatchObject({ allowed: false, refundCents: 0 });
      expect(preview.body.message).toContain('card dispute');
      const cancelled = await agent.post(`/api/v1/bookings/${booking.ref}/cancel`);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.error.code).toBe('PAYMENT_DISPUTED');
    }
    expect(client.refunds.create).not.toHaveBeenCalled();
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');
  });

  it('can still be cancelled and refunded during an inquiry, which isn’t a chargeback yet', async () => {
    const { booking, guest, payment } = await chargedBack('warning_needs_response');
    const agent = await signIn(guest.email);
    const cancelled = await agent.post(`/api/v1/bookings/${booking.ref}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 33_870 }),
      expect.anything(),
    );

    // Charged back after it was cancelled: the cancellation still reads as the refund it was.
    await PaymentModel.updateOne({ _id: payment._id }, { $set: { 'dispute.status': 'needs_response' } });
    const view = (await agent.get(`/api/v1/bookings/${booking.ref}`)).body.booking;
    expect(view.cancellation).toMatchObject({ refundCents: 33_870 });
    expect(view.cancellation).not.toHaveProperty('disputed');
  });

  it('tells the Guest and Host the payment already went back when the dispute is settled', async () => {
    const { booking, host, guest } = await chargedBack('lost', new Date(Date.now() - 3 * HOUR_MS));
    const cancelled = await (
      await staffAgent()
    )
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.cancellation).toMatchObject({ refundCents: 0, disputed: true });
    const told = (userId: unknown, channel: string) =>
      NotificationModel.findOne({ userId, type: 'BOOKING_CANCELLED', channel }).lean();
    expect((await told(guest._id, 'EMAIL'))!.payload).toMatchObject({
      props: { disputed: true, disputeSettled: true },
    });
    expect(((await told(guest._id, 'IN_APP'))!.payload as { body: string }).body).toBe(
      'Your card payment for it was returned to your card through a dispute with your bank.',
    );
    expect((await told(host._id, 'EMAIL'))!.payload).toMatchObject({
      props: { disputed: true, disputeSettled: true },
    });
  });

  it('is cancelled by staff without a refund or a payout to the Host, and staff are told to refund if it’s won', async () => {
    const { booking, payment, payout } = await chargedBack(
      'needs_response',
      new Date(Date.now() - 3 * HOUR_MS),
    );
    const admin = await staffAgent();
    const preview = await admin
      .get(`/api/v1/admin/bookings/${booking.ref}/cancellation-preview`)
      .query({ reason: 'GUEST_NO_SHOW' });
    // A no-show would keep half the rental, and pay the Host a share of it: the dispute decides the money instead.
    expect(preview.body).toMatchObject({
      allowed: true,
      kind: 'GUEST_CANCELLATION',
      refundCents: 0,
      feeCents: 0,
      hostShareCents: 0,
    });
    expect(preview.body.message).toContain('card dispute');
    expect(preview.body.message).toContain('If the dispute is won, refund the Guest');

    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { reason: 'GUEST_NO_SHOW', refundCents: 0, feeCents: 0, disputed: true },
    });
    expect(client.refunds.create).not.toHaveBeenCalled();
    expect((await PaymentModel.findById(payment._id).lean())!).toMatchObject({
      status: 'SUCCEEDED',
      refunds: [],
    });
    // The Host isn't paid from money going back to the cardholder.
    expect((await PayoutModel.findById(payout._id).lean())!.status).toBe('CANCELLED');
    expect(await PayoutModel.exists({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toBeNull();
    const stored = (await BookingModel.findById(booking._id).lean())!;
    expect(stored.hostShareCents).toBe(0);
    expect(stored.statusHistory.at(-1)!.reason).toContain(
      'the card dispute on its payment decides the money',
    );
    expect(await inApp('CANCELLED_IN_DISPUTE')).toMatchObject({
      payload: expect.objectContaining({
        link: `/admin/bookings/${booking.ref}`,
        body: expect.stringContaining('If the dispute is won, refund the guest'),
      }),
    });
    const email = await NotificationModel.findOne({
      type: 'BOOKING_CANCELLED',
      channel: 'EMAIL',
      dedupeKey: `BOOKING_CANCELLED:${booking.id}:guest`,
    }).lean();
    expect(email!.payload).toMatchObject({ props: { disputed: true } });
    expect(
      (await AuditLogModel.findOne({ action: 'booking.guest-cancellation', entityId: booking.id }).lean())!
        .after,
    ).toMatchObject({ refundCents: 0, disputed: true });
  });

  it('says plainly when Stripe refuses a staff refund because of a dispute, instead of failing', async () => {
    const { ids } = await parties();
    await createStaff();
    const booking = await createBookingRecord(ids);
    await createPaymentRecord(booking);
    vi.mocked(client.refunds.create).mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        code: 'charge_disputed',
        message: 'Charge ch_1 has been charged back; cannot issue a refund.',
      }),
    );
    const refunded = await (
      await staffAgent()
    )
      .post(`/api/v1/admin/bookings/${booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'Goodwill', fundedBy: 'PLATFORM' });
    expect(refunded.status).toBe(409);
    expect(refunded.body.error.code).toBe('PAYMENT_DISPUTED');
  });

  it('tells a Guest whose refund Stripe refuses to contact support, without Stripe’s own words', async () => {
    const { booking, guest } = await chargedBack('warning_closed');
    vi.mocked(client.refunds.create).mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        code: 'charge_already_refunded',
        message: 'Charge ch_1 has already been refunded.',
      }),
    );
    const cancelled = await (await signIn(guest.email)).post(`/api/v1/bookings/${booking.ref}/cancel`);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error).toMatchObject({
      code: 'REFUND_REFUSED',
      message: 'We couldn’t refund this payment just now. Please contact support and we’ll sort it out.',
    });
    expect(JSON.stringify(cancelled.body)).not.toContain('ch_1');
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');
  });
});

describe('a Radar early fraud warning (plan §14)', () => {
  const warning = (paymentIntent: string, id = 'issfr_1') => ({
    id,
    object: 'radar.early_fraud_warning',
    actionable: true,
    charge: 'ch_1',
    created: 1_790_000_000,
    fraud_type: 'made_with_stolen_card',
    livemode: false,
    payment_intent: paymentIntent,
  });

  it('flags the Guest and alerts staff with the booking, suggesting a refund before a chargeback', async () => {
    const { ids, guest } = await parties();
    await createStaff();
    const booking = await createBookingRecord(ids);
    const payment = await createPaymentRecord(booking);

    expect(
      (await webhook('radar.early_fraud_warning.created', warning(payment.stripePaymentIntentId))).status,
    ).toBe(200);
    const flags = (await UserModel.findById(guest._id).lean())!.riskFlags ?? [];
    expect(flags).toEqual([
      expect.objectContaining({ code: 'RADAR_WARNING', detail: expect.stringContaining(booking.ref) }),
    ]);
    expect(await inApp('EARLY_FRAUD_WARNING')).toMatchObject({
      payload: expect.objectContaining({
        link: `/admin/bookings/${booking.ref}`,
        body: expect.stringContaining('refund the payment, or cancel the booking, before one is opened'),
      }),
    });

    // Another warning while the flag waits for review adds no second flag.
    await webhook('radar.early_fraud_warning.created', warning(payment.stripePaymentIntentId, 'issfr_2'));
    expect((await UserModel.findById(guest._id).lean())!.riskFlags).toHaveLength(1);
  });

  it('ignores a warning about a payment that isn’t a booking’s', async () => {
    const { guest } = await parties();
    await createStaff();
    expect((await webhook('radar.early_fraud_warning.created', warning('pi_unknown'))).status).toBe(200);
    expect((await UserModel.findById(guest._id).lean())!.riskFlags ?? []).toEqual([]);
    expect(await inApp('EARLY_FRAUD_WARNING')).toBeNull();
  });
});

describe('a Guest cancelling after staff refunded part of the trip (plan §8.1, items 10 and 15)', () => {
  async function partlyRefunded(refundedCents: number) {
    const { ids, guest } = await parties();
    const booking = await createBookingRecord(ids, {
      cancellationPolicy: 'FLEXIBLE',
      cancellationTerms: FLEXIBLE,
    });
    const payment = await createPaymentRecord(booking, {
      status: refundedCents >= 33_870 ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: refundedCents,
          reason: 'Goodwill',
          kind: 'STAFF',
          fundedBy: 'PLATFORM',
          stripeRefundId: 're_staff',
          status: 'SUCCEEDED',
          createdAt: new Date(),
        },
      ],
    });
    return { booking, payment, agent: await signIn(guest.email) };
  }

  it('previews and refunds only what’s left, and says what was already given back', async () => {
    const { booking, payment, agent } = await partlyRefunded(5_000);
    const preview = await agent.get(`/api/v1/bookings/${booking.ref}/cancellation-preview`);
    expect(preview.body).toMatchObject({
      allowed: true,
      kind: 'GUEST_CANCELLATION',
      refundCents: 28_870,
      feeCents: 0,
    });
    expect(preview.body.message).toBe(
      "You'll get a full refund of $288.70. You’ve already had $50.00 back, which comes off the $338.70 the policy gives back.",
    );

    const cancelled = await agent.post(`/api/v1/bookings/${booking.ref}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.cancellation).toMatchObject({ refundCents: 28_870 });
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 28_870 }),
      expect.anything(),
    );
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('REFUNDED');
  });

  it('still cancels, refunding nothing, when everything was already refunded', async () => {
    const { booking, agent } = await partlyRefunded(33_870);
    const preview = await agent.get(`/api/v1/bookings/${booking.ref}/cancellation-preview`);
    expect(preview.body).toMatchObject({ allowed: true, refundCents: 0 });
    expect(preview.body.message).toBe(
      'Everything you paid has already been refunded, so nothing more comes back.',
    );

    const cancelled = await agent.post(`/api/v1/bookings/${booking.ref}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking).toMatchObject({ status: 'CANCELLED', cancellation: { refundCents: 0 } });
    expect(client.refunds.create).not.toHaveBeenCalled();
  });
});

describe('a booking that reaches its start time before it’s confirmed (plan §8.2)', () => {
  it('gives a request no longer than until the trip starts', async () => {
    const { ids } = await parties();
    const startAt = new Date(Date.now() + 6 * HOUR_MS);
    const booking = await createBookingRecord(ids, {
      status: 'PAYMENT_PENDING',
      instantBook: false,
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
    });
    await withTransaction((session) => markRequested(booking, session));
    expect((await BookingModel.findById(booking._id).lean())!.requestExpiresAt).toEqual(startAt);
    expect((await JobModel.findOne({ type: 'booking.expireRequest' }).lean())!.runAt).toEqual(startAt);
  });

  it('can’t be accepted once the trip has started: it ends, and the card hold is released', async () => {
    const { ids, host } = await parties();
    const startAt = new Date(Date.now() - HOUR_MS);
    const booking = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      // Made before the request's time was capped at the start.
      requestExpiresAt: new Date(Date.now() + 5 * HOUR_MS),
    });
    const payment = await createPaymentRecord(booking, { status: 'AUTHORISED' });
    const hostAgent = await signIn(host.email);

    const accepted = await hostAgent.post(`/api/v1/bookings/${booking.ref}/accept`);
    expect(accepted.status).toBe(409);
    expect(accepted.body.error.code).toBe('TRIP_STARTED');
    expect(client.paymentIntents.capture).not.toHaveBeenCalled();
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith(
      payment.stripePaymentIntentId,
      {},
      expect.anything(),
    );
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('EXPIRED');
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('CANCELLED');
  });

  it('isn’t confirmed by a verification approved after the trip started', async () => {
    const { ids, guest } = await parties();
    const startAt = new Date(Date.now() - HOUR_MS);
    const booking = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: true,
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      requestExpiresAt: new Date(Date.now() + 5 * HOUR_MS),
      verificationReview: { status: 'PENDING' },
    });
    await createPaymentRecord(booking, { status: 'AUTHORISED' });

    const outcome = await resolveVerificationReview(guest.id, 'APPROVE', undefined);
    expect(outcome).toMatchObject({ confirmed: [], released: [booking.ref] });
    expect(client.paymentIntents.capture).not.toHaveBeenCalled();
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('EXPIRED');
  });
});

describe('a Guest who doesn’t turn up after the Host’s check-in (plan §8.2, no-shows)', () => {
  /** A trip that started 3 hours ago with the Host's check-in alone. */
  async function hostCheckedIn(confirmedByGuest = false) {
    const { ids, host, guest } = await parties();
    const startAt = new Date(Date.now() - 3 * HOUR_MS);
    const booking = await createBookingRecord(ids, {
      status: 'ACTIVE',
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      cancellationPolicy: 'FLEXIBLE',
      cancellationTerms: FLEXIBLE,
    });
    const payment = await createPaymentRecord(booking);
    await ConditionReportModel.create({
      bookingId: booking._id,
      stage: 'CHECK_IN',
      submittedBy: host._id,
      odometer: 45_000,
      fuelOrBatteryPct: 80,
      photos: [],
      confirmedByHostAt: new Date(startAt.getTime() - HOUR_MS),
      ...(confirmedByGuest && { confirmedByGuestAt: new Date() }),
    });
    return { booking, payment, guest };
  }

  it('lets staff cancel the trip as a Guest no-show, refunded as a cancellation at the start time', async () => {
    const { booking, payment } = await hostCheckedIn();
    await createStaff();
    const admin = await staffAgent();
    const preview = await admin
      .get(`/api/v1/admin/bookings/${booking.ref}/cancellation-preview`)
      .query({ reason: 'GUEST_NO_SHOW' });
    // Flexible: half the rental and service fee back from the start time, with all of the protection.
    expect(preview.body).toMatchObject({
      allowed: true,
      kind: 'GUEST_CANCELLATION',
      refundCents: 13_350 + 1_335 + 4_500,
      hoursBeforeStart: 0,
    });
    expect(
      (
        await admin
          .get(`/api/v1/admin/bookings/${booking.ref}/cancellation-preview`)
          .query({ reason: 'PLATFORM' })
      ).body.allowed,
    ).toBe(false);

    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'The guest never arrived; the host checked the car in' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { reason: 'GUEST_NO_SHOW', refundCents: 19_185 },
    });
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: payment.stripePaymentIntentId, amount: 19_185 }),
      expect.anything(),
    );
  });

  it('doesn’t let staff cancel a trip the Guest confirmed', async () => {
    const { booking } = await hostCheckedIn(true);
    await createStaff();
    const admin = await staffAgent();
    const refused = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'Said they never arrived' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_CANCELLABLE');
  });

  it('asks the Guest to confirm the check-in after an hour, and alerts staff after two', async () => {
    const { booking, guest } = await hostCheckedIn();
    await createStaff();
    await startCheckJob({ bookingId: booking.id, hoursAfter: 1 }, context);
    expect(await inApp('CHECK_IN_UNCONFIRMED')).toMatchObject({ userId: guest._id });
    await startCheckJob({ bookingId: booking.id, hoursAfter: 2 }, context);
    expect(await inApp('TRIP_CHECK_IN_UNCONFIRMED')).toMatchObject({
      payload: expect.objectContaining({ title: `Possible no-show on ${booking.ref}` }),
    });
  });

  it('says nothing once the Guest has confirmed the check-in', async () => {
    const { booking } = await hostCheckedIn(true);
    await createStaff();
    await startCheckJob({ bookingId: booking.id, hoursAfter: 1 }, context);
    await startCheckJob({ bookingId: booking.id, hoursAfter: 2 }, context);
    expect(await inApp('CHECK_IN_UNCONFIRMED')).toBeNull();
    expect(await inApp('TRIP_CHECK_IN_UNCONFIRMED')).toBeNull();
  });
});

describe('the Stripe webhook and duplicate keys (plan §8.1, item 13)', () => {
  it('treats only a repeated event id as a repeat: another duplicate key fails, so Stripe retries', async () => {
    const original = stripeEventHandlers['charge.refunded'];
    const { ids } = await parties();
    const booking = await createBookingRecord(ids);
    const payment = await createPaymentRecord(booking);
    // A handler that trips over a unique index of its own.
    stripeEventHandlers['charge.refunded'] = async (_event, session) => {
      await PaymentModel.create([{ ...payment.toObject(), _id: new mongoose.Types.ObjectId() }], { session });
    };
    try {
      const charge = {
        id: 'ch_1',
        object: 'charge',
        payment_intent: payment.stripePaymentIntentId,
        amount_refunded: 0,
      };
      const failed = await webhook('charge.refunded', charge);
      expect(failed.status).toBe(500);
      expect(await StripeEventModel.countDocuments()).toBe(0);
    } finally {
      stripeEventHandlers['charge.refunded'] = original;
    }
  });
});

describe('a refund made outside the app (plan §8.1, items 13 and 15)', () => {
  it('is recorded from Stripe a few minutes on, as funded by the platform, and staff are asked to check it', async () => {
    const { ids } = await parties();
    await createStaff();
    const booking = await createBookingRecord(ids);
    const payment = await createPaymentRecord(booking);
    const charge = {
      id: 'ch_1',
      object: 'charge',
      payment_intent: payment.stripePaymentIntentId,
      amount_refunded: 5_000,
    };
    expect((await webhook('charge.refunded', charge)).status).toBe(200);
    const job = await JobModel.findOne({ type: 'payment.syncRefunds' }).lean();
    expect(job!.payload).toEqual({ paymentId: payment.id });
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 4 * MINUTE_MS);

    vi.spyOn(client.refunds, 'list').mockResolvedValue({
      data: [{ id: 're_dashboard', amount: 5_000, status: 'succeeded', created: 1_790_000_000 }],
    } as never);
    await syncRefundsJob({ paymentId: payment.id }, context);
    await syncRefundsJob({ paymentId: payment.id }, context);
    expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        expect.objectContaining({
          amountCents: 5_000,
          stripeRefundId: 're_dashboard',
          reason: 'Recorded from Stripe',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
        }),
      ],
    });
    expect(await inApp('REFUND_UNRECORDED')).not.toBeNull();
  });

  it('isn’t looked for when everything Stripe refunded is recorded', async () => {
    const { ids } = await parties();
    const booking = await createBookingRecord(ids);
    const payment = await createPaymentRecord(booking, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 5_000,
          reason: 'Goodwill',
          fundedBy: 'PLATFORM',
          stripeRefundId: 're_known',
          status: 'PENDING',
          createdAt: new Date(),
        },
      ],
    });
    const charge = {
      id: 'ch_1',
      object: 'charge',
      payment_intent: payment.stripePaymentIntentId,
      amount_refunded: 5_000,
    };
    expect((await webhook('charge.refunded', charge)).status).toBe(200);
    expect(await JobModel.countDocuments({ type: 'payment.syncRefunds' })).toBe(0);
    expect((await PaymentModel.findById(payment._id).lean())!.refunds[0]!.status).toBe('SUCCEEDED');
  });
});
