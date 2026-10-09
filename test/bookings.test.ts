import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEmail } from '../src/emails/index.js';
import type { BookingCancelledProps, RefundIssuedProps } from '../src/emails/templates/booking-emails.js';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import { refundUnwantedJob } from '../src/jobs/handlers/booking-jobs.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { JobModel } from '../src/jobs/job.model.js';
import { createJobRunner } from '../src/jobs/runner.js';
import { forget } from '../src/lib/memo.js';
import { parseNzDateTime } from '../src/lib/nz-time.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import {
  expirePaymentHold,
  expireRequest,
  updateResponseRate,
} from '../src/modules/bookings/booking.service.js';
import { guestCancellation, refundPctFor } from '../src/modules/bookings/policies.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { smsSendTime } from '../src/modules/notifications/notify.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createHost, createVehicle, nzDay } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

const client = stripe();
const app = testApp();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
type Agent = ReturnType<typeof browserAgent>;

let intentStatus: Stripe.PaymentIntent.Status = 'requires_payment_method';
let intentCount = 0;

function intent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.Response<Stripe.PaymentIntent> {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    client_secret: 'pi_1_secret',
    amount: 0,
    currency: 'nzd',
    status: intentStatus,
    metadata: {},
    latest_charge: null,
    last_payment_error: null,
    ...overrides,
  } as unknown as Stripe.Response<Stripe.PaymentIntent>;
}

/** Stripe calls answered locally; the intent's status is whatever the test sets in `intentStatus`. */
function mockStripe() {
  intentCount = 0;
  // Each intent keeps the capture method it was created with, as Stripe's do.
  const captureMethods = new Map<string, Stripe.PaymentIntent.CaptureMethod>();
  const spies = {
    customer: vi
      .spyOn(client.customers, 'create')
      .mockResolvedValue({ id: 'cus_1' } as Stripe.Response<Stripe.Customer>),
    create: vi.spyOn(client.paymentIntents, 'create').mockImplementation(async (params) => {
      intentCount += 1;
      const captureMethod = params.capture_method ?? 'automatic';
      captureMethods.set(`pi_${intentCount}`, captureMethod);
      return intent({
        id: `pi_${intentCount}`,
        client_secret: `pi_${intentCount}_secret`,
        amount: params.amount,
        capture_method: captureMethod,
      });
    }),
    retrieve: vi
      .spyOn(client.paymentIntents, 'retrieve')
      .mockImplementation(async (id) =>
        intent({ id: String(id), capture_method: captureMethods.get(String(id)) ?? 'automatic' }),
      ),
    capture: vi
      .spyOn(client.paymentIntents, 'capture')
      .mockImplementation(async (id) => intent({ id: String(id), status: 'succeeded' })),
    cancel: vi
      .spyOn(client.paymentIntents, 'cancel')
      .mockImplementation(async (id) => intent({ id: String(id), status: 'canceled' })),
    session: vi
      .spyOn(client.customerSessions, 'create')
      .mockResolvedValue({ client_secret: 'cuss_secret' } as Stripe.Response<Stripe.CustomerSession>),
    refund: vi
      .spyOn(client.refunds, 'create')
      .mockImplementation(
        async (params) =>
          ({ id: 're_1', status: 'succeeded', amount: params?.amount }) as Stripe.Response<Stripe.Refund>,
      ),
  };
  return spies;
}

function webhook(type: string, object: object, id = `evt_${Math.random().toString(36).slice(2)}`) {
  const payload = JSON.stringify({
    id,
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

/** A Guest who can book: verified mobile and licence details. */
async function readyGuest(email = 'kiri@example.co.nz', phone = '+64221112222') {
  const guest = await createUser({ email, firstName: 'Kiri' });
  await UserModel.updateOne(
    { _id: guest._id },
    {
      $set: {
        phone,
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
        identityVerification: { status: 'APPROVED', verifiedAt: new Date() },
      },
    },
  );
  const agent = await signIn(email);
  const licence = await agent.put('/api/v1/me/driver-licence').send({
    number: 'AB123456',
    version: '123',
    class: 'NZ_FULL',
    issuedAt: '2012-05-01',
    expiry: '2034-05-01',
    dob: '1990-04-21',
  });
  expect(licence.status).toBe(200);
  expect(licence.body.problems).toEqual([]);
  // Their ID was this licence, so the identity check confirmed it (plan §8.2).
  await UserModel.updateOne({ _id: guest._id }, { $set: { 'driverLicence.status': 'APPROVED' } });
  return { guest, agent };
}

async function hostWithCar(instantBook: boolean) {
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
  return { host, vehicle, hostAgent: await signIn(host.email) };
}

const trip = (vehicleId: string, startDay = 10, endDay = 13) => ({
  vehicleId,
  start: nzDay(startDay),
  end: nzDay(endDay),
});

async function paidBooking(instantBook = true, startDay = 10) {
  const setup = await hostWithCar(instantBook);
  const { guest, agent } = await readyGuest();
  const created = await agent.post('/api/v1/bookings').send(trip(setup.vehicle.id, startDay, startDay + 3));
  expect(created.status).toBe(201);
  const id = created.body.booking.id as string;
  const payment = await agent.post(`/api/v1/bookings/${id}/payment`).send({ acceptGuestAgreement: true });
  expect(payment.status).toBe(200);
  const pi = await PaymentModel.findOne({ bookingId: id }).lean();
  return {
    ...setup,
    guest,
    agent,
    id,
    ref: created.body.booking.ref as string,
    piId: pi!.stripePaymentIntentId,
  };
}

beforeEach(() => {
  forget();
  intentStatus = 'requires_payment_method';
});
afterEach(() => vi.restoreAllMocks());

describe('Checkout readiness and licence details', () => {
  it('lists what a Guest still needs, and checks the licence rules', async () => {
    const user = await createUser();
    const agent = await signIn(user.email);
    const empty = await agent.get('/api/v1/me/checkout');
    expect(empty.body.problems.map((problem: { code: string }) => problem.code)).toEqual([
      'PHONE_REQUIRED',
      // Identity before the first booking (plan §16, item 5).
      'IDENTITY_REQUIRED',
      'LICENCE_REQUIRED',
    ]);

    const badNumber = await agent.put('/api/v1/me/driver-licence').send({
      number: '12345',
      class: 'NZ_FULL',
      issuedAt: '2020-01-01',
      expiry: '2030-01-01',
      dob: '2008-01-01',
    });
    expect(Object.keys(badNumber.body.error.fields).sort()).toEqual(['number', 'version']);

    const young = await agent.put('/api/v1/me/driver-licence').send({
      number: 'ab123456',
      version: '001',
      class: 'NZ_RESTRICTED',
      issuedAt: '2026-03-01',
      expiry: '2030-01-01',
      dob: '2008-01-01',
    });
    expect(young.status).toBe(200);
    expect(young.body.licence).toMatchObject({
      class: 'NZ_RESTRICTED',
      numberEnding: '456',
      status: 'PENDING',
    });
    expect(young.body.problems.map((problem: { code: string }) => problem.code)).toEqual([
      'PHONE_REQUIRED',
      'IDENTITY_REQUIRED',
      'TOO_YOUNG',
      'CLASS_NOT_ACCEPTED',
      'NOT_LICENSED_LONG_ENOUGH',
    ]);
    const stored = await UserModel.findById(user._id).select('+driverLicence.number').lean();
    expect(stored!.driverLicence!.number).not.toContain('AB123456');

    // The same licence on another account raises a risk flag instead of an error.
    const other = await createUser({ email: 'other@example.co.nz' });
    const otherAgent = await signIn(other.email);
    await otherAgent.put('/api/v1/me/driver-licence').send({
      number: 'AB123456',
      version: '002',
      class: 'NZ_FULL',
      issuedAt: '2010-01-01',
      expiry: '2030-01-01',
      dob: '1980-01-01',
    });
    expect((await UserModel.findById(other._id).lean())!.riskFlags.map((flag) => flag.code)).toEqual([
      'DUPLICATE_LICENCE',
    ]);

    const overseas = await otherAgent.put('/api/v1/me/driver-licence').send({
      number: 'D1234567',
      class: 'OVERSEAS',
      country: 'Germany',
      notInEnglish: true,
      issuedAt: '2010-01-01',
      expiry: '2030-01-01',
      dob: '1980-01-01',
    });
    expect(overseas.body.error.fields.englishProof).toBeDefined();
  });
});

describe('Booking an Instant Book car', () => {
  it('holds the dates for 30 minutes, then confirms on the payment webhook', async () => {
    const stripeSpies = mockStripe();
    const { vehicle } = await hostWithCar(true);
    const { guest, agent } = await readyGuest();

    const created = await agent.post('/api/v1/bookings').send(trip(vehicle.id));
    expect(created.body.error).toBeUndefined();
    expect(created.status).toBe(201);
    const booking = created.body.booking;
    expect(booking).toMatchObject({
      status: 'PAYMENT_PENDING',
      role: 'GUEST',
      instantBook: true,
      days: 3,
      cancellationTier: { code: 'MODERATE' },
      actions: { pay: true, cancel: false },
      price: { subtotalCents: 26_700, serviceFeeCents: 2_670, protectionCents: 4_500, totalCents: 33_870 },
    });
    expect(booking.ref).toMatch(/^RV-[A-Z0-9]{6}$/);
    expect(new Date(booking.holdExpiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    // Before confirmation the Guest doesn't see the plate, the street or the Host's mobile.
    expect(booking.vehicle.regoPlate).toBeUndefined();
    expect(booking.pickup.address).toBeUndefined();
    expect(booking.host.phone).toBeUndefined();

    const blocks = await AvailabilityBlockModel.find({ bookingId: booking.id }).lean();
    expect(blocks.map((block) => block.reason).sort()).toEqual(['BUFFER', 'HOLD']);
    expect(await JobModel.countDocuments({ type: 'booking.expirePaymentHold', status: 'QUEUED' })).toBe(1);

    // The same request again (a double click) returns the same booking.
    const again = await agent.post('/api/v1/bookings').send(trip(vehicle.id));
    expect(again.body.booking.id).toBe(booking.id);

    const noAgreement = await agent.post(`/api/v1/bookings/${booking.id}/payment`).send({});
    expect(noAgreement.body.error.fields.acceptGuestAgreement).toBe('Please accept the Guest Agreement');
    const session = await agent
      .post(`/api/v1/bookings/${booking.id}/payment`)
      .send({ acceptGuestAgreement: true });
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      clientSecret: 'pi_1_secret',
      customerSessionClientSecret: 'cuss_secret',
      amountCents: 33_870,
      currency: 'nzd',
      captureMethod: 'automatic',
      verificationInReview: false,
      holdExpiresAt: booking.holdExpiresAt,
    });
    expect(stripeSpies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 33_870,
        currency: 'nzd',
        customer: 'cus_1',
        capture_method: 'automatic',
        setup_future_usage: 'off_session',
        metadata: expect.objectContaining({ bookingId: booking.id, bookingRef: booking.ref }),
      }),
      expect.objectContaining({ idempotencyKey: `booking-${booking.id}-payment-1` }),
    );
    expect(
      (await UserModel.findById(guest._id).lean())!.agreements.map((agreement) => agreement.type),
    ).toContain('GUEST');
    // Asking again reuses the unfinished payment.
    await agent.post(`/api/v1/bookings/${booking.id}/payment`).send({ acceptGuestAgreement: true });
    expect(stripeSpies.create).toHaveBeenCalledTimes(1);

    const event = {
      id: 'pi_1',
      object: 'payment_intent',
      status: 'succeeded',
      amount: 33_870,
      metadata: { bookingId: booking.id },
    };
    expect((await webhook('payment_intent.succeeded', event, 'evt_paid')).status).toBe(200);
    expect((await webhook('payment_intent.succeeded', event, 'evt_paid')).body.duplicate).toBe(true);

    const confirmed = await agent.get(`/api/v1/bookings/${booking.ref}`);
    expect(confirmed.body.booking).toMatchObject({
      status: 'CONFIRMED',
      payment: { status: 'SUCCEEDED' },
      vehicle: { regoPlate: expect.stringMatching(/^TST/) },
      pickup: { address: '1 Ponsonby Road, Ponsonby, Auckland 1011', instructions: 'Parked out the front.' },
      host: { phone: '+64211234567' },
      actions: { pay: false, cancel: true },
    });
    const confirmedBlocks = await AvailabilityBlockModel.find({ bookingId: booking.id }).lean();
    expect(confirmedBlocks.map((block) => [block.reason, block.expiresAt])).toEqual(
      expect.arrayContaining([
        ['BOOKED', undefined],
        ['BUFFER', undefined],
      ]),
    );
    expect(await JobModel.countDocuments({ type: 'booking.expirePaymentHold', status: 'CANCELLED' })).toBe(1);
    expect(await JobModel.countDocuments({ type: 'payment.receipt' })).toBe(1);

    const types = (await NotificationModel.find({ type: 'BOOKING_CONFIRMED' }).lean())
      .map((item) => item.channel)
      .sort();
    // Guest: in-app and email; Host: in-app, email and SMS (an Instant Book is news to them).
    expect(types).toEqual(['EMAIL', 'EMAIL', 'IN_APP', 'IN_APP', 'SMS']);

    // Delivering the queued notifications and the receipt.
    stripeSpies.retrieve.mockImplementation(async (id) =>
      intent({
        id: String(id),
        status: 'succeeded',
        latest_charge: {
          created: 1_790_000_000,
          payment_method_details: { card: { brand: 'visa', last4: '4242', wallet: { type: 'apple_pay' } } },
        } as Stripe.Charge,
      }),
    );
    // Run during NZ's quiet hours, the Host's text waits for the morning; bring it forward.
    await JobModel.updateMany(
      { type: 'notification.send', status: 'QUEUED' },
      { $set: { runAt: new Date() } },
    );
    await createJobRunner().drain();
    const receipt = await NotificationModel.findOne({ type: 'PAYMENT_RECEIPT', channel: 'EMAIL' }).lean();
    expect(receipt).toMatchObject({
      status: 'SENT',
      payload: {
        template: 'paymentReceipt',
        props: { method: 'Apple Pay (Visa ending 4242)', total: '$338.70' },
      },
    });
    expect(await NotificationModel.countDocuments({ status: 'SENT', channel: 'SMS' })).toBe(1);
  });

  it('confirms through the browser sync when the webhook is late', async () => {
    mockStripe();
    const { id, ref, agent } = await paidBooking();
    intentStatus = 'succeeded';
    const synced = await agent.post(`/api/v1/bookings/${id}/payment/sync`);
    expect(synced.body.booking).toMatchObject({ ref, status: 'CONFIRMED' });
  });

  it('refuses a Guest who isn’t ready, the Host’s own car, and taken dates', async () => {
    mockStripe();
    const { vehicle, hostAgent } = await hostWithCar(true);
    const own = await hostAgent.post('/api/v1/bookings').send(trip(vehicle.id));
    expect(own.body.error.code).toBe('OWN_CAR');

    const newcomer = await createUser({ email: 'new@example.co.nz' });
    const newcomerAgent = await signIn(newcomer.email);
    const notReady = await newcomerAgent.post('/api/v1/bookings').send(trip(vehicle.id));
    expect(notReady.status).toBe(409);
    expect(notReady.body.error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      fields: { verification: 'PHONE_REQUIRED,IDENTITY_REQUIRED,LICENCE_REQUIRED' },
    });

    const { agent } = await readyGuest();
    await agent.post('/api/v1/bookings').send(trip(vehicle.id));
    const { agent: second } = await readyGuest('mere@example.co.nz', '+64223334444');
    const taken = await second.post('/api/v1/bookings').send(trip(vehicle.id, 12, 14));
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('DATES_UNAVAILABLE');
  });

  it('releases the dates when payment isn’t finished in 30 minutes, unless it went through', async () => {
    mockStripe();
    const { id, ref, agent, hostAgent } = await paidBooking();
    const later = new Date(Date.now() + 31 * 60_000);
    expect(await expirePaymentHold(id, later)).toBe('expired');
    expect((await BookingModel.findById(id).lean())!.status).toBe('EXPIRED');
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    expect((await PaymentModel.findOne({ bookingId: id }).lean())!.status).toBe('CANCELLED');
    // Nothing was charged and nothing was booked: it's in neither list (a checkout left or started again
    // would otherwise pile up as "Expired" trips), though its page still opens from a link.
    const guestList = await agent.get('/api/v1/bookings').query({ group: 'cancelled' });
    expect(guestList.body.bookings).toEqual([]);
    expect((await agent.get(`/api/v1/bookings/${ref}`)).body.booking).toMatchObject({ status: 'EXPIRED' });
    for (const query of [{ role: 'host', group: 'cancelled' }, { role: 'host' }]) {
      expect((await hostAgent.get('/api/v1/bookings').query(query)).body.bookings).toEqual([]);
    }

    await BookingModel.deleteMany({});
    await PaymentModel.deleteMany({});
    await UserModel.deleteMany({});
    const late = await paidBooking();
    intentStatus = 'succeeded';
    expect(await expirePaymentHold(late.id, later)).toBe('paid');
    expect((await BookingModel.findById(late.id).lean())!.status).toBe('CONFIRMED');
  });

  it('refunds a payment that went through after the booking ended, and tells the Guest why', async () => {
    const spies = mockStripe();
    const { id, ref } = await paidBooking();
    await BookingModel.updateOne({ _id: id }, { $set: { status: 'EXPIRED' } });
    const payment = await PaymentModel.findOneAndUpdate(
      { bookingId: id },
      { $set: { status: 'SUCCEEDED' } },
      { new: true },
    );
    const context = { log: { warn: vi.fn() } } as unknown as JobContext;

    await refundUnwantedJob({ paymentId: payment!.id }, context);
    // A retry finds it refunded and does nothing more.
    await refundUnwantedJob({ paymentId: payment!.id }, context);

    expect(spies.refund).toHaveBeenCalledTimes(1);
    const emails = await NotificationModel.find({ type: 'REFUND_ISSUED', channel: 'EMAIL' }).lean();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.payload).toMatchObject({
      template: 'refundIssued',
      props: { ref, afterBookingEnded: true },
    });
    const rendered = await renderEmail(
      'refundIssued',
      (emails[0]!.payload as { props: RefundIssuedProps }).props,
    );
    expect(rendered.text).toContain('went through after the booking had ended');
  });

  it('tells the Guest once when a payment fails, and keeps the dates held', async () => {
    mockStripe();
    const { id, piId } = await paidBooking();
    const failed = {
      id: piId,
      object: 'payment_intent',
      status: 'requires_payment_method',
      last_payment_error: { message: 'Your card was declined.' },
    };
    await webhook('payment_intent.payment_failed', failed);
    await webhook('payment_intent.payment_failed', failed);
    expect((await PaymentModel.findOne({ bookingId: id }).lean())!.failureReason).toBe(
      'Your card was declined.',
    );
    expect(await NotificationModel.countDocuments({ type: 'PAYMENT_FAILED', channel: 'EMAIL' })).toBe(1);
    expect((await BookingModel.findById(id).lean())!.status).toBe('PAYMENT_PENDING');
  });
});

describe('Request to book', () => {
  async function requested() {
    const booking = await paidBooking(false);
    const authorised = {
      id: booking.piId,
      object: 'payment_intent',
      status: 'requires_capture',
      amount: 33_870,
    };
    expect((await webhook('payment_intent.amount_capturable_updated', authorised)).status).toBe(200);
    return booking;
  }

  it('authorises the card, sends the request to the Host, and confirms when they accept', async () => {
    const spies = mockStripe();
    const { id, ref, hostAgent, piId } = await requested();
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ capture_method: 'manual' }),
      expect.anything(),
    );

    const booking = await BookingModel.findById(id).lean();
    expect(booking!.status).toBe('PENDING');
    expect(booking!.requestExpiresAt!.getTime() - Date.now()).toBeGreaterThan(23 * HOUR_MS);
    const hold = await AvailabilityBlockModel.findOne({ bookingId: id, reason: 'HOLD' }).lean();
    expect(hold!.expiresAt!.getTime()).toBe(booking!.requestExpiresAt!.getTime());
    expect(await JobModel.countDocuments({ type: 'booking.expireRequest', status: 'QUEUED' })).toBe(1);
    const hostNotes = await NotificationModel.find({ type: 'BOOKING_REQUEST' }).lean();
    expect(hostNotes.map((note) => note.channel).sort()).toEqual(['EMAIL', 'IN_APP', 'SMS']);

    const hostView = await hostAgent.get(`/api/v1/bookings/${ref}`);
    expect(hostView.body.booking).toMatchObject({
      role: 'HOST',
      actions: { accept: true, decline: true },
      payout: { hostPayoutCents: 21_360 },
    });
    expect(hostView.body.booking.guest.phone).toBeUndefined();
    expect(
      (await hostAgent.get('/api/v1/bookings').query({ role: 'host', group: 'requests' })).body.bookings,
    ).toHaveLength(1);

    const accepted = await hostAgent.post(`/api/v1/bookings/${ref}/accept`);
    expect(accepted.status).toBe(200);
    expect(spies.capture).toHaveBeenCalledWith(piId, {}, { idempotencyKey: `capture-${piId}` });
    expect(accepted.body.booking).toMatchObject({ status: 'CONFIRMED', guest: { phone: '+64221112222' } });
    expect(await JobModel.countDocuments({ type: 'booking.expireRequest', status: 'CANCELLED' })).toBe(1);
    expect((await UserModel.findById(booking!.hostId).lean())!.hostProfile!.responseRate).toBe(100);
  });

  it('releases the card when the Host declines, with no fee', async () => {
    const spies = mockStripe();
    const { id, ref, hostAgent, agent } = await requested();
    expect((await hostAgent.post(`/api/v1/bookings/${ref}/cancel`)).body.error.code).toBe('USE_DECLINE');
    const declined = await hostAgent
      .post(`/api/v1/bookings/${ref}/decline`)
      .send({ reason: 'Car needs a service' });
    expect(declined.body.booking.status).toBe('DECLINED');
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_DECLINED', channel: 'EMAIL' })).toBe(1);
    expect((await agent.get('/api/v1/bookings').query({ group: 'cancelled' })).body.bookings).toHaveLength(1);
  });

  it('expires after 24 hours without an answer', async () => {
    mockStripe();
    const { id, ref, hostAgent } = await requested();
    expect(await expireRequest(id)).toBe(false);
    expect(await expireRequest(id, new Date(Date.now() + 25 * HOUR_MS))).toBe(true);
    expect((await BookingModel.findById(id).lean())!.status).toBe('EXPIRED');
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_EXPIRED', channel: 'EMAIL' })).toBe(2);
    // A request the Host let run out stays in their bookings.
    const hostList = await hostAgent.get('/api/v1/bookings').query({ role: 'host', group: 'cancelled' });
    expect(hostList.body.bookings).toEqual([expect.objectContaining({ ref, status: 'EXPIRED' })]);
  });

  it('lets the Guest withdraw before the Host answers', async () => {
    mockStripe();
    const { ref, agent } = await requested();
    const preview = await agent.get(`/api/v1/bookings/${ref}/cancellation-preview`);
    expect(preview.body).toMatchObject({
      allowed: true,
      kind: 'WITHDRAW_REQUEST',
      refundCents: 0,
      feeCents: 0,
    });
    const withdrawn = await agent.post(`/api/v1/bookings/${ref}/cancel`);
    expect(withdrawn.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { reason: 'REQUEST_WITHDRAWN', by: 'GUEST' },
    });

    // Both emails say the request was withdrawn, not that a booking was cancelled.
    const emails = await NotificationModel.find({ type: 'REQUEST_WITHDRAWN', channel: 'EMAIL' }).lean();
    const payloads = emails.map((email) => email.payload as { template: 'bookingCancelled'; props: object });
    expect(payloads.map((payload) => payload.props)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ audience: 'GUEST', withdrawn: true }),
        expect.objectContaining({ audience: 'HOST', withdrawn: true }),
      ]),
    );
    const guestEmail = payloads.find(
      (payload) => (payload.props as { audience: string }).audience === 'GUEST',
    )!;
    const rendered = await renderEmail('bookingCancelled', guestEmail.props as BookingCancelledProps);
    expect(rendered.subject).toBe(`Request ${ref} is withdrawn`);
    expect(rendered.text).toContain("You haven't been charged");
    expect(rendered.text.toLowerCase()).not.toContain('booking cancelled');
  });

  it('lets staff cancel a request as a platform cancellation, releasing the card, after a preview', async () => {
    const spies = mockStripe();
    const { id, ref, host } = await requested();
    await createStaff();
    const admin = await staffAgent();
    const preview = (reason: string) =>
      admin.get(`/api/v1/admin/bookings/${ref}/cancellation-preview`).query({ reason });

    // A no-show needs a confirmed trip.
    const noShow = await preview('GUEST_NO_SHOW');
    expect(noShow.body).toMatchObject({ allowed: false, kind: null, refundCents: 0 });
    expect(noShow.body.message).toMatch(/only to a confirmed booking/);
    const platform = await preview('PLATFORM');
    expect(platform.body).toMatchObject({
      allowed: true,
      kind: 'PLATFORM_CANCELLATION',
      refundCents: 0,
      feeCents: 0,
      hostFeeCents: 0,
      releasedCents: 33_870,
    });
    expect(platform.body.message).toContain('$338.70 held on the Guest’s card is released');
    expect((await preview('LATE')).status).toBe(400);

    const refused = await admin
      .post(`/api/v1/admin/bookings/${ref}/cancel`)
      .send({ reason: 'HOST_NO_SHOW', note: 'Host never answered' });
    expect(refused.body.error.code).toBe('NOT_CONFIRMED');

    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${ref}/cancel`)
      .send({ reason: 'PLATFORM', note: 'The car failed its WOF' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { by: 'SUPPORT', reason: 'PLATFORM', refundCents: 0 },
    });
    // The authorisation is released, not refunded, and the held dates are free.
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.refund).not.toHaveBeenCalled();
    expect((await PaymentModel.findOne({ bookingId: id }).lean())!.status).toBe('CANCELLED');
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    expect(await JobModel.countDocuments({ type: 'booking.expireRequest', status: 'QUEUED' })).toBe(0);
    const stored = await BookingModel.findById(id).lean();
    expect(stored!.statusHistory.at(-1)).toMatchObject({
      status: 'CANCELLED',
      reason: 'The car failed its WOF',
    });

    // Both are told; the Guest that nothing was charged.
    const emails = await NotificationModel.find({ type: 'BOOKING_CANCELLED', channel: 'EMAIL' }).lean();
    expect(emails.map((email) => email.userId.toString()).sort()).toEqual(
      [stored!.guestId.toString(), host.id].sort(),
    );
    const guestEmail = emails.find((email) => email.userId.equals(stored!.guestId))!;
    const props = (guestEmail.payload as { props: BookingCancelledProps }).props;
    expect(props).toMatchObject({ audience: 'GUEST', cancelledBy: 'SUPPORT', released: true });
    const rendered = await renderEmail('bookingCancelled', props);
    expect(rendered.text).toContain('our support team cancelled');
    expect(rendered.text).toContain("You haven't been charged");
    expect(await NotificationModel.countDocuments({ type: 'REFUND_ISSUED' })).toBe(0);

    const audit = await AuditLogModel.findOne({ action: 'booking.platform-cancellation' }).lean();
    expect(audit).toMatchObject({
      before: { status: 'PENDING' },
      after: { reason: 'PLATFORM', note: 'The car failed its WOF', authorisationReleased: true },
    });
    // A request support cancelled before the Host answered isn't counted in their response rate at all.
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.responseRate': 50 } });
    await updateResponseRate(host._id);
    expect((await UserModel.findById(host._id).lean())!.hostProfile!.responseRate).toBe(50);
  });
});

describe('Verification in review', () => {
  const authorised = (piId: string) => ({
    id: piId,
    object: 'payment_intent',
    status: 'requires_capture',
    amount: 33_870,
  });

  /** A Guest whose identity check is with support books and pays: the card is authorised only. */
  async function bookedInReview(instantBook: boolean) {
    const setup = await hostWithCar(instantBook);
    const { guest, agent } = await readyGuest();
    await UserModel.updateOne({ _id: guest._id }, { $set: { identityVerification: { status: 'PENDING' } } });
    const created = await agent.post('/api/v1/bookings').send(trip(setup.vehicle.id));
    expect(created.status).toBe(201);
    const ref = created.body.booking.ref as string;
    const id = created.body.booking.id as string;
    const payment = await agent.post(`/api/v1/bookings/${ref}/payment`).send({ acceptGuestAgreement: true });
    expect(payment.body).toMatchObject({ captureMethod: 'manual', verificationInReview: true });
    const piId = (await PaymentModel.findOne({ bookingId: id }).lean())!.stripePaymentIntentId;
    expect((await webhook('payment_intent.amount_capturable_updated', authorised(piId))).status).toBe(200);
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const support = await staffAgent('mere@example.co.nz');
    const review = (decision: 'APPROVE' | 'REJECT') =>
      support.post(`/api/v1/admin/users/${guest.id}/identity-review`).send({ decision });
    return { ...setup, guest, agent, ref, id, piId, review };
  }

  it('turns an Instant Book into a request that support confirms by approving the check', async () => {
    const spies = mockStripe();
    const { agent, hostAgent, vehicle, guest, ref, id, piId, review } = await bookedInReview(true);
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ capture_method: 'manual' }),
      expect.anything(),
    );

    // Authorised, not charged: the Guest is told why, and the dates stay held for 24 hours.
    const pending = await agent.get(`/api/v1/bookings/${ref}`);
    expect(pending.body.booking).toMatchObject({
      status: 'PENDING',
      instantBook: true,
      verificationReview: 'PENDING',
      payment: { status: 'AUTHORISED' },
      actions: { withdraw: true },
    });
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id, reason: 'HOLD' })).toBe(1);
    const told = await NotificationModel.find({ type: 'BOOKING_VERIFICATION_REVIEW' }).lean();
    expect(told.map((note) => note.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(told.find((note) => note.channel === 'EMAIL')!.payload).toMatchObject({
      template: 'bookingVerificationReview',
      props: { total: '$338.70' },
    });

    // Nothing for the Host to answer: no request arrives, and they can't accept or decline it.
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_REQUEST' })).toBe(0);
    const hostView = await hostAgent.get(`/api/v1/bookings/${ref}`);
    expect(hostView.body.booking.actions).toMatchObject({ accept: false, decline: false });
    expect((await hostAgent.post(`/api/v1/bookings/${ref}/accept`)).body.error.code).toBe('NOT_A_REQUEST');
    expect((await hostAgent.post(`/api/v1/bookings/${ref}/decline`)).body.error.code).toBe('NOT_A_REQUEST');
    const hostLists = async (group: string) =>
      (await hostAgent.get('/api/v1/bookings').query({ role: 'host', group })).body.bookings;
    expect(await hostLists('requests')).toEqual([]);
    expect(await hostLists('upcoming')).toEqual([
      expect.objectContaining({ ref, status: 'PENDING', verificationReview: 'PENDING' }),
    ]);
    const calendar = await hostAgent
      .get(`/api/v1/host/vehicles/${vehicle.id}/calendar`)
      .query({ from: nzDay(9).slice(0, 10), to: nzDay(15).slice(0, 10) });
    const held = calendar.body.blocks.find((block: { reason: string }) => block.reason === 'HOLD');
    expect(held.booking).toMatchObject({ ref, status: 'PENDING', toAnswer: false });

    // Support approves the check: the card is charged and the booking confirmed, for both parties.
    const approved = await review('APPROVE');
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({
      identityStatus: 'APPROVED',
      confirmed: [ref],
      waitingForHost: [],
      released: [],
    });
    expect(spies.capture).toHaveBeenCalledWith(piId, {}, { idempotencyKey: `capture-${piId}` });
    const booking = await BookingModel.findById(id).lean();
    expect(booking).toMatchObject({ status: 'CONFIRMED', verificationReview: { status: 'APPROVED' } });
    expect(booking!.verificationReview!.decidedBy).toBeDefined();
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id, reason: 'BOOKED' })).toBe(1);
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_CONFIRMED', channel: 'EMAIL' })).toBe(2);
    expect((await UserModel.findById(guest._id).lean())!.identityVerification).toMatchObject({
      status: 'APPROVED',
    });
    // An Instant Book never counts towards the Host's response rate: it stays where it was.
    expect((await UserModel.findById(booking!.hostId).lean())!.hostProfile!.responseRate).toBe(100);

    // Decided once: a second decision has nothing to review.
    expect((await review('REJECT')).body.error.code).toBe('NOT_IN_REVIEW');
  });

  it('releases the card when support rejects the check, and stops the Guest booking again', async () => {
    const spies = mockStripe();
    const { agent, vehicle, ref, id, review } = await bookedInReview(true);

    const rejected = await review('REJECT');
    expect(rejected.body).toEqual({
      identityStatus: 'REJECTED',
      confirmed: [],
      waitingForHost: [],
      released: [ref],
    });
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.capture).not.toHaveBeenCalled();
    expect(await BookingModel.findById(id).lean()).toMatchObject({
      status: 'EXPIRED',
      verificationReview: { status: 'REJECTED' },
    });
    expect((await PaymentModel.findOne({ bookingId: id }).lean())!.status).toBe('CANCELLED');
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    const emails = await NotificationModel.find({ type: 'BOOKING_EXPIRED', channel: 'EMAIL' }).lean();
    // Only the Guest: the Host of an Instant Book car never heard of it.
    expect(emails).toHaveLength(1);
    expect(emails[0]!.payload).toMatchObject({
      template: 'bookingDeclined',
      props: { outcome: 'VERIFICATION_REJECTED' },
    });

    const again = await agent.post('/api/v1/bookings').send(trip(vehicle.id, 20, 23));
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      fields: { verification: 'IDENTITY_REJECTED' },
    });
  });

  it('needs both the Host’s answer and the check for a request, in either order', async () => {
    const spies = mockStripe();
    const first = await bookedInReview(false);
    // The Host is asked as usual, and the Guest hears about the check instead of "request sent".
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_REQUEST', channel: 'EMAIL' })).toBe(1);
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_REQUEST_SENT' })).toBe(0);
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_VERIFICATION_REVIEW' })).toBe(2);

    // The Host accepts first: recorded, not charged yet.
    const accepted = await first.hostAgent.post(`/api/v1/bookings/${first.ref}/accept`);
    expect(accepted.body.booking).toMatchObject({
      status: 'PENDING',
      hostAccepted: true,
      verificationReview: 'PENDING',
      actions: { accept: false, decline: false },
    });
    expect(spies.capture).not.toHaveBeenCalled();
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_HOST_ACCEPTED' })).toBe(1);
    expect(
      (await first.hostAgent.get('/api/v1/bookings').query({ role: 'host', group: 'requests' })).body
        .bookings,
    ).toEqual([]);
    // Then the check is approved: now it's confirmed.
    expect((await first.review('APPROVE')).body.confirmed).toEqual([first.ref]);
    expect((await BookingModel.findById(first.id).lean())!.status).toBe('CONFIRMED');
    expect(spies.capture).toHaveBeenCalledTimes(1);
    expect((await UserModel.findById(first.host._id).lean())!.hostProfile!.responseRate).toBe(100);

    // The other order, for a second Guest and car: approved first, it waits for the Host.
    await BookingModel.deleteMany({});
    await PaymentModel.deleteMany({});
    await AvailabilityBlockModel.deleteMany({});
    await UserModel.updateOne(
      { _id: first.guest._id },
      { $set: { identityVerification: { status: 'PENDING' } } },
    );
    const created = await first.agent.post('/api/v1/bookings').send(trip(first.vehicle.id, 20, 23));
    const ref = created.body.booking.ref as string;
    await first.agent.post(`/api/v1/bookings/${ref}/payment`).send({ acceptGuestAgreement: true });
    const piId = (await PaymentModel.findOne({ bookingId: created.body.booking.id }).lean())!
      .stripePaymentIntentId;
    await webhook('payment_intent.amount_capturable_updated', authorised(piId));
    expect((await first.review('APPROVE')).body).toMatchObject({ confirmed: [], waitingForHost: [ref] });
    expect((await BookingModel.findOne({ ref }).lean())!.status).toBe('PENDING');
    const answered = await first.hostAgent.post(`/api/v1/bookings/${ref}/accept`);
    expect(answered.body.booking.status).toBe('CONFIRMED');
    expect(spies.capture).toHaveBeenCalledTimes(2);
  });

  it('expires after 24 hours without a decision, without blaming the Host', async () => {
    const spies = mockStripe();
    const { id, ref, host, hostAgent } = await bookedInReview(false);
    // The Host did their part; the check never came back.
    expect((await hostAgent.post(`/api/v1/bookings/${ref}/accept`)).status).toBe(200);
    expect(await expireRequest(id, new Date(Date.now() + 25 * HOUR_MS))).toBe(true);
    expect((await BookingModel.findById(id).lean())!.status).toBe('EXPIRED');
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.capture).not.toHaveBeenCalled();

    const emails = await NotificationModel.find({ type: 'BOOKING_EXPIRED', channel: 'EMAIL' }).lean();
    const payloads = emails.map((email) => email.payload as { template: string; props: object });
    expect(payloads.find((payload) => payload.template === 'bookingDeclined')!.props).toMatchObject({
      outcome: 'VERIFICATION_EXPIRED',
    });
    expect(payloads.find((payload) => payload.template === 'requestExpiredHost')!.props).toMatchObject({
      guestNotVerified: true,
    });
    // An accepted request counts as answered; counted as expired, the rate would have dropped to 0.
    expect((await UserModel.findById(host._id).lean())!.hostProfile!.responseRate).toBe(100);
  });

  it('charges straight away once the check is approved before paying', async () => {
    const spies = mockStripe();
    const { vehicle } = await hostWithCar(true);
    const { guest, agent } = await readyGuest();
    await UserModel.updateOne({ _id: guest._id }, { $set: { identityVerification: { status: 'PENDING' } } });
    const created = await agent.post('/api/v1/bookings').send(trip(vehicle.id));
    const ref = created.body.booking.ref as string;
    const waiting = await agent.post(`/api/v1/bookings/${ref}/payment`).send({ acceptGuestAgreement: true });
    expect(waiting.body.captureMethod).toBe('manual');

    // The check comes back approved while the Guest is still at the payment step.
    await UserModel.updateOne({ _id: guest._id }, { $set: { identityVerification: { status: 'APPROVED' } } });
    const ready = await agent.post(`/api/v1/bookings/${ref}/payment`).send({ acceptGuestAgreement: true });
    expect(ready.body).toMatchObject({ captureMethod: 'automatic', verificationInReview: false });
    // The authorise-only payment is dropped for one that charges.
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.create).toHaveBeenCalledTimes(2);
    expect(ready.body.clientSecret).not.toBe(waiting.body.clientSecret);
    expect((await BookingModel.findOne({ ref }).lean())!.verificationReview).toBeUndefined();
  });

  it('is for staff only', async () => {
    const { guest, agent } = await readyGuest();
    const refused = await agent
      .post(`/api/v1/admin/users/${guest.id}/identity-review`)
      .send({ decision: 'APPROVE' });
    expect(refused.status).toBe(403);
  });

  it('lets staff cancel a booking waiting for the check, without telling a Host who never heard of it', async () => {
    const spies = mockStripe();
    const { guest, ref, id } = await bookedInReview(true);
    await createStaff();
    const admin = await staffAgent();
    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${ref}/cancel`)
      .send({ reason: 'PLATFORM', note: 'The Guest asked us to cancel' });
    expect(cancelled.body.booking).toMatchObject({ status: 'CANCELLED', cancellation: { by: 'SUPPORT' } });
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    const emails = await NotificationModel.find({ type: 'BOOKING_CANCELLED', channel: 'EMAIL' }).lean();
    expect(emails.map((email) => email.userId.toString())).toEqual([guest.id]);
  });
});

describe('Licence in review', () => {
  const authorised = (piId: string) => ({
    id: piId,
    object: 'payment_intent',
    status: 'requires_capture',
    amount: 33_870,
  });
  const codes = (body: { problems: { code: string }[] }) => body.problems.map((problem) => problem.code);

  /**
   * A Guest whose ID was a passport, so their licence waits for support (plan §8.2), books an Instant Book
   * car and pays: the card is authorised only.
   */
  async function bookedWithLicenceInReview(identity: 'APPROVED' | 'PENDING' = 'APPROVED') {
    const setup = await hostWithCar(true);
    const { guest, agent } = await readyGuest();
    await UserModel.updateOne(
      { _id: guest._id },
      {
        $set: {
          'driverLicence.status': 'PENDING',
          identityVerification: { status: identity, documentType: 'passport' },
        },
      },
    );
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const readiness = await agent.get('/api/v1/me/checkout');
    expect(readiness.body).toMatchObject({ licenceInReview: true, problems: [] });
    const created = await agent.post('/api/v1/bookings').send(trip(setup.vehicle.id));
    expect(created.status).toBe(201);
    const ref = created.body.booking.ref as string;
    const id = created.body.booking.id as string;
    const payment = await agent.post(`/api/v1/bookings/${ref}/payment`).send({ acceptGuestAgreement: true });
    expect(payment.body).toMatchObject({ captureMethod: 'manual', verificationInReview: true });
    const piId = (await PaymentModel.findOne({ bookingId: id }).lean())!.stripePaymentIntentId;
    expect((await webhook('payment_intent.amount_capturable_updated', authorised(piId))).status).toBe(200);
    const support = await staffAgent('mere@example.co.nz');
    const review = (kind: 'licence' | 'identity', decision: 'APPROVE' | 'REJECT', note?: string) =>
      support.post(`/api/v1/admin/users/${guest.id}/${kind}-review`).send({ decision, note });
    return { ...setup, guest, agent, ref, id, piId, support, review };
  }

  it('turns an Instant Book into a request that support confirms by approving the licence', async () => {
    const spies = mockStripe();
    const { ref, id, piId, guest, support, review } = await bookedWithLicenceInReview();
    expect(await BookingModel.findById(id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'PENDING' },
    });
    // Support is told a booking waits on them, and finds the licence in the queue with the booking.
    expect(
      await NotificationModel.countDocuments({ type: 'VERIFICATION_BOOKING_WAITING', channel: 'IN_APP' }),
    ).toBe(1);
    const queue = await support.get('/api/v1/admin/verifications');
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        userId: guest.id,
        kind: 'LICENCE',
        reason: expect.stringMatching(/passport/),
        waitingBookings: [expect.objectContaining({ ref })],
      }),
    ]);

    const approved = await review('licence', 'APPROVE');
    expect(approved.body).toEqual({
      licenceStatus: 'APPROVED',
      confirmed: [ref],
      waitingForHost: [],
      released: [],
    });
    expect(spies.capture).toHaveBeenCalledWith(piId, {}, { idempotencyKey: `capture-${piId}` });
    expect(await BookingModel.findById(id).lean()).toMatchObject({
      status: 'CONFIRMED',
      verificationReview: { status: 'APPROVED' },
    });
    expect(
      await NotificationModel.countDocuments({
        userId: guest._id,
        type: 'LICENCE_APPROVED',
        channel: 'EMAIL',
      }),
    ).toBe(1);
    // Decided once.
    expect((await review('licence', 'REJECT')).body.error.code).toBe('NOT_IN_REVIEW');
  });

  it('releases the card when support rejects the licence', async () => {
    const spies = mockStripe();
    const { agent, ref, id, review } = await bookedWithLicenceInReview();
    const rejected = await review('licence', 'REJECT', 'The licence has expired.');
    expect(rejected.body).toEqual({
      licenceStatus: 'REJECTED',
      confirmed: [],
      waitingForHost: [],
      released: [ref],
    });
    expect((await BookingModel.findById(id).lean())!.status).toBe('EXPIRED');
    expect(spies.cancel).toHaveBeenCalledTimes(1);
    expect(spies.capture).not.toHaveBeenCalled();
    expect(codes((await agent.get('/api/v1/me/checkout')).body)).toContain('LICENCE_REJECTED');
  });

  it('waits for both when the identity check and the licence are with support', async () => {
    const spies = mockStripe();
    const { ref, id, review } = await bookedWithLicenceInReview('PENDING');

    // The identity check passes, but the licence still waits: so does the booking.
    const identity = await review('identity', 'APPROVE');
    expect(identity.body).toEqual({
      identityStatus: 'APPROVED',
      confirmed: [],
      waitingForHost: [],
      released: [],
      stillInReview: [ref],
    });
    expect(spies.capture).not.toHaveBeenCalled();
    expect(await BookingModel.findById(id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'PENDING' },
    });

    const licence = await review('licence', 'APPROVE');
    expect(licence.body.confirmed).toEqual([ref]);
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
  });

  it('asks support to check every new licence when no identity check is needed before booking', async () => {
    mockStripe();
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { verification: { identityBeforeFirstBooking: false } },
    });
    const { vehicle } = await hostWithCar(true);
    const { guest, agent } = await readyGuest();
    await UserModel.updateOne(
      { _id: guest._id },
      { $set: { 'driverLicence.status': 'PENDING' }, $unset: { identityVerification: 1 } },
    );
    expect((await agent.get('/api/v1/me/checkout')).body).toMatchObject({
      licenceInReview: true,
      problems: [],
    });
    const created = await agent.post('/api/v1/bookings').send(trip(vehicle.id));
    const payment = await agent
      .post(`/api/v1/bookings/${created.body.booking.ref}/payment`)
      .send({ acceptGuestAgreement: true });
    expect(payment.body).toMatchObject({ captureMethod: 'manual', verificationInReview: true });

    await createStaff();
    const queue = await (await staffAgent()).get('/api/v1/admin/verifications');
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        userId: guest.id,
        kind: 'LICENCE',
        reason: expect.stringMatching(/No identity check/),
      }),
    ]);
  });
});

describe('Cancellations', () => {
  it('refunds a Guest cancellation under the booking’s tier, and shares the kept rental with the Host', async () => {
    const spies = mockStripe();
    // Moderate: full refund 5+ days before, 50% from 24 hours, then nothing. Pick-up is in 3 days.
    const { id, ref, agent, piId, hostAgent } = await paidBooking(true, 3);
    await webhook('payment_intent.succeeded', { id: piId, object: 'payment_intent', status: 'succeeded' });

    const preview = await agent.get(`/api/v1/bookings/${ref}/cancellation-preview`);
    expect(preview.body).toMatchObject({
      allowed: true,
      kind: 'GUEST_CANCELLATION',
      refundPct: 50,
      feeCents: 13_350 + 1_335,
    });
    expect(preview.body.refundCents).toBe(33_870 - 14_685);
    expect(preview.body.message).toBe("Under the Moderate policy you'll get $191.85 back; $146.85 is kept.");
    const hostPreview = await hostAgent.get(`/api/v1/bookings/${ref}/cancellation-preview`);
    expect(hostPreview.body).toMatchObject({
      kind: 'HOST_CANCELLATION',
      refundCents: 33_870,
      hostFeeCents: 0,
    });

    const cancelled = await agent.post(`/api/v1/bookings/${ref}/cancel`).send({ reason: 'Plans changed' });
    expect(cancelled.status).toBe(200);
    expect(spies.refund).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: piId, amount: 19_185 }),
      { idempotencyKey: `refund-${id}-cancellation` },
    );
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { by: 'GUEST', reason: 'GUEST_CANCELLED', refundCents: 19_185, feeCents: 14_685 },
    });
    const stored = await BookingModel.findById(id).lean();
    // The Host gets the kept rental ($133.50) less the 20% commission.
    expect(stored!.hostShareCents).toBe(10_680);
    expect((await PaymentModel.findOne({ bookingId: id }).lean())!).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refunds: [expect.objectContaining({ amountCents: 19_185, fundedBy: 'HOST', status: 'SUCCEEDED' })],
    });
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    expect(await NotificationModel.countDocuments({ type: 'BOOKING_CANCELLED', channel: 'EMAIL' })).toBe(2);
    expect(await NotificationModel.countDocuments({ type: 'REFUND_ISSUED' })).toBe(2);
    expect((await agent.post(`/api/v1/bookings/${ref}/cancel`)).status).toBe(409);
  });

  it('refunds everything when the Host cancels, and adds the Host fee to what they owe', async () => {
    mockStripe();
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { cancellation: { hostCancellationFeeCents: 5_000 } },
    });
    const { ref, piId, hostAgent, host } = await paidBooking(true, 20);
    await webhook('payment_intent.succeeded', { id: piId, object: 'payment_intent', status: 'succeeded' });
    const cancelled = await hostAgent.post(`/api/v1/bookings/${ref}/cancel`);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { by: 'HOST', reason: 'HOST_CANCELLED', refundCents: 33_870, hostFeeCents: 5_000 },
    });
    expect((await UserModel.findById(host._id).lean())!.hostProfile!.feesOwedCents).toBe(5_000);
  });

  it('lets staff with the refunds permission cancel a no-show', async () => {
    mockStripe();
    const { ref, piId } = await paidBooking(true, 20);
    await webhook('payment_intent.succeeded', { id: piId, object: 'payment_intent', status: 'succeeded' });
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const support = await staffAgent('mere@example.co.nz');
    const refused = await support
      .post(`/api/v1/admin/bookings/${ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'Did not arrive' });
    expect(refused.status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    const noShow = await admin
      .post(`/api/v1/admin/bookings/${ref}/cancel`)
      .send({ reason: 'GUEST_NO_SHOW', note: 'Did not arrive' });
    // A no-show is a Guest cancellation at the start time: nothing back under Moderate.
    expect(noShow.body.booking).toMatchObject({
      status: 'CANCELLED',
      role: 'STAFF',
      cancellation: { by: 'SUPPORT', reason: 'GUEST_NO_SHOW', feeCents: 33_870 - 4_500 },
    });
  });

  it('previews what a staff cancellation would refund for each reason, less earlier refunds', async () => {
    mockStripe();
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { cancellation: { hostCancellationFeeCents: 5_000 } },
    });
    const { ref, id, piId } = await paidBooking(true, 20);
    await webhook('payment_intent.succeeded', { id: piId, object: 'payment_intent', status: 'succeeded' });
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const support = await staffAgent('mere@example.co.nz');
    const preview = (reason: string) =>
      support.get(`/api/v1/admin/bookings/${ref}/cancellation-preview`).query({ reason });

    // Support staff see the preview; one that refunds money says it needs the refunds permission.
    const guestNoShow = await preview('GUEST_NO_SHOW');
    expect(guestNoShow.status).toBe(200);
    expect(guestNoShow.body).toMatchObject({
      allowed: false,
      kind: 'GUEST_CANCELLATION',
      refundCents: 4_500,
      feeCents: 33_870 - 4_500,
      hostFeeCents: 0,
      releasedCents: 0,
    });
    expect(guestNoShow.body.hostShareCents).toBeGreaterThan(0);
    expect(guestNoShow.body.message).toContain('the Guest gets $45.00 back');
    expect(guestNoShow.body.message).toContain('needs the refunds permission');
    const hostNoShow = await preview('HOST_NO_SHOW');
    expect(hostNoShow.body).toMatchObject({
      kind: 'HOST_CANCELLATION',
      refundCents: 33_870,
      hostFeeCents: 5_000,
    });
    expect(hostNoShow.body.message).toContain('A Host cancellation fee of $50.00');

    // $25 already refunded by staff: a full refund is what's left.
    await PaymentModel.updateOne(
      { stripePaymentIntentId: piId },
      {
        $set: { status: 'PARTIALLY_REFUNDED' },
        $push: {
          refunds: { amountCents: 2_500, reason: 'Dirty car', fundedBy: 'PLATFORM', status: 'SUCCEEDED' },
        },
      },
    );
    const platform = await preview('PLATFORM');
    expect(platform.body).toMatchObject({
      kind: 'PLATFORM_CANCELLATION',
      refundCents: 31_370,
      hostFeeCents: 0,
    });
    expect(platform.body.message).toContain('less what was already refunded');

    await createStaff();
    const admin = await staffAgent();
    const cancelled = await admin
      .post(`/api/v1/admin/bookings/${ref}/cancel`)
      .send({ reason: 'PLATFORM', note: 'The car was written off' });
    expect(cancelled.body.booking.cancellation).toMatchObject({ reason: 'PLATFORM', refundCents: 31_370 });
    expect((await PaymentModel.findOne({ bookingId: id }).lean())!.status).toBe('REFUNDED');
    // Once it's cancelled there's nothing more to cancel.
    expect((await preview('PLATFORM')).body).toMatchObject({ allowed: false, kind: null });
  });

  it('applies the tier rules by time before pick-up', () => {
    const terms = {
      code: 'MODERATE',
      name: 'Moderate',
      summary: '',
      refunds: [
        { minHoursBefore: 120, refundPct: 100 },
        { minHoursBefore: 24, refundPct: 50 },
        { minHoursBefore: 0, refundPct: 0 },
      ],
    };
    expect(refundPctFor(terms, 200)).toBe(100);
    expect(refundPctFor(terms, 120)).toBe(100);
    expect(refundPctFor(terms, 119.9)).toBe(50);
    expect(refundPctFor(terms, 1)).toBe(0);
    expect(refundPctFor(terms, -5)).toBe(0);
    const booking = {
      startAt: new Date(Date.now() + 10 * DAY_MS),
      price: {
        subtotalCents: 10_000,
        deliveryCents: 3_000,
        serviceFeeCents: 1_000,
        protectionCents: 2_000,
        gstCents: 0,
        totalCents: 16_000,
        hostPayoutCents: 11_000,
        platformFeeCents: 3_000,
      },
      cancellationTerms: terms,
    };
    expect(
      guestCancellation(booking, { cancellation: { guestCancellationHostSharePct: 100 } } as never),
    ).toMatchObject({ refundCents: 16_000, feeCents: 0 });
    const soon = { ...booking, startAt: new Date(Date.now() + 2 * DAY_MS) };
    // 50%: $50 rental and $5 fee kept; delivery and protection refunded.
    expect(
      guestCancellation(soon, { cancellation: { guestCancellationHostSharePct: 100 } } as never),
    ).toMatchObject({
      refundCents: 16_000 - 5_500,
      feeCents: 5_500,
      hostShareCents: 4_000,
    });
  });
});

describe('Text messages and quiet hours', () => {
  const nz = (value: string) => parseNzDateTime(value)!;

  it('sends straight away by day, and holds a night-time text until the morning', () => {
    expect(smsSendTime(nz('2026-10-05T14:30'), '21:00', '07:00')).toEqual(nz('2026-10-05T14:30'));
    expect(smsSendTime(nz('2026-10-05T07:00'), '21:00', '07:00')).toEqual(nz('2026-10-05T07:00'));
    // After 9 pm it waits for the next morning; after midnight, for the same morning.
    expect(smsSendTime(nz('2026-10-05T21:00'), '21:00', '07:00')).toEqual(nz('2026-10-06T07:00'));
    expect(smsSendTime(nz('2026-10-05T23:45'), '21:00', '07:00')).toEqual(nz('2026-10-06T07:00'));
    expect(smsSendTime(nz('2026-10-06T00:20'), '21:00', '07:00')).toEqual(nz('2026-10-06T07:00'));
    // Quiet hours that don't cross midnight.
    expect(smsSendTime(nz('2026-10-05T13:10'), '12:00', '14:00')).toEqual(nz('2026-10-05T14:00'));
  });
});

describe('Trips and bookings lists', () => {
  it('groups a Guest’s trips and a Host’s bookings', async () => {
    mockStripe();
    const { ref, piId, agent, hostAgent } = await paidBooking(true, 15);
    expect((await agent.get('/api/v1/bookings')).body.bookings).toEqual([]);
    await webhook('payment_intent.succeeded', { id: piId, object: 'payment_intent', status: 'succeeded' });
    const upcoming = await agent.get('/api/v1/bookings').query({ group: 'upcoming' });
    expect(upcoming.body.bookings).toEqual([
      expect.objectContaining({
        ref,
        status: 'CONFIRMED',
        otherParty: { firstName: 'Hana' },
        amountCents: 33_870,
      }),
    ]);
    const hostList = await hostAgent.get('/api/v1/bookings').query({ role: 'host', group: 'upcoming' });
    expect(hostList.body.bookings[0]).toMatchObject({
      ref,
      otherParty: { firstName: 'Kiri' },
      amountCents: 21_360,
    });
    const stranger = await signIn((await createUser({ email: 'x@example.co.nz' })).email);
    expect((await stranger.get(`/api/v1/bookings/${ref}`)).status).toBe(404);
    expect(parseNzDateTime(nzDay(15))).not.toBeNull();
  });
});
