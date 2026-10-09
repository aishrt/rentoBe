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
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import type { UnwantedReason } from '../src/modules/bookings/booking-payments.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { expirePaymentHold, resolveVerificationReview } from '../src/modules/bookings/booking.service.js';
import { confirmBooking } from '../src/modules/bookings/booking-transitions.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { runPayout } from '../src/modules/payouts/payouts.service.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel, type Vehicle } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle, nzDay } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

/*
 * Money around a booking's lifecycle: staff cancellations and who may make them, payments that arrive after
 * their dates were taken or their car suspended, payout deductions and extra-charge refunds, Host fee waivers,
 * earnings, payout setup and dates, the booking lists and closing an account.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const client = stripe();
const app = testApp();
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;
type Agent = ReturnType<typeof browserAgent>;

const NEEDS_REFUNDS_PERMISSION =
  'Cancelling it refunds the Guest, which needs the refunds permission: ask the administrator.';
const FLEXIBLE = {
  code: 'FLEXIBLE',
  name: 'Flexible',
  summary: 'Full refund up to 24 hours before pickup, then 50%.',
  refunds: [
    { minHoursBefore: 24, refundPct: 100 },
    { minHoursBefore: 0, refundPct: 50 },
  ],
};

/** What Stripe says a booking's PaymentIntent is doing when asked. */
let intentStatus: Stripe.PaymentIntent.Status = 'requires_payment_method';
/** What Stripe answers a new refund with: 'failed' when the card can't take it. */
let refundStatus: Stripe.Refund['status'] = 'succeeded';
let intentCount = 0;
let refundCount = 0;
let transfers: Stripe.TransferCreateParams[] = [];

function intent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.Response<Stripe.PaymentIntent> {
  return {
    id: 'pi_1',
    object: 'payment_intent',
    client_secret: 'pi_1_secret',
    amount: 0,
    currency: 'nzd',
    status: intentStatus,
    metadata: {},
    latest_charge: 'ch_1',
    last_payment_error: null,
    ...overrides,
  } as unknown as Stripe.Response<Stripe.PaymentIntent>;
}

beforeEach(() => {
  forget();
  intentStatus = 'requires_payment_method';
  refundStatus = 'succeeded';
  intentCount = 0;
  refundCount = 0;
  transfers = [];
  // Each intent keeps the capture method it was created with, as Stripe's do.
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
      status: refundStatus,
      amount: params?.amount,
      ...(refundStatus === 'failed' && { failure_reason: 'expired_or_canceled_card' }),
    } as Stripe.Response<Stripe.Refund>;
  });
  vi.spyOn(client.transfers, 'create').mockImplementation(async (params) => {
    transfers.push(params);
    return { id: `tr_${transfers.length}` } as Stripe.Response<Stripe.Transfer>;
  });
  // Stripe's list of the transfers made so far, as runPayout checks before making one.
  vi.spyOn(client.transfers, 'list').mockImplementation(((params?: Stripe.TransferListParams) =>
    Promise.resolve({
      data: transfers
        .map((transfer, index) => ({ ...transfer, id: `tr_${index + 1}`, reversed: false }))
        .filter((transfer) => transfer.transfer_group === params?.transfer_group),
    })) as unknown as typeof client.transfers.list);
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

async function signIn(email: string): Promise<Agent> {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

const refundsOwed = async (hostId: unknown) =>
  (await UserModel.findById(hostId).lean())!.hostProfile!.refundsOwed ?? [];

// Booking through the API -------------------------------------------------------------------------------------

/** A Guest who can book: verified mobile, identity and licence. */
async function readyGuest(email = 'kiri@example.co.nz', phone = '+64221112222', licence = 'AB123456') {
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
  const saved = await agent.put('/api/v1/me/driver-licence').send({
    number: licence,
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

const tripDates = (vehicleId: string, startDay = 10, endDay = 13) => ({
  vehicleId,
  start: nzDay(startDay),
  end: nzDay(endDay),
});

/** A Guest's new booking, its dates held for 30 minutes, before the payment step. */
async function book(instantBook = true) {
  const setup = await hostWithCar(instantBook);
  const { guest, agent } = await readyGuest();
  const created = await agent.post('/api/v1/bookings').send(tripDates(setup.vehicle.id));
  expect(created.status).toBe(201);
  return {
    ...setup,
    guest,
    agent,
    id: created.body.booking.id as string,
    ref: created.body.booking.ref as string,
  };
}

/** A booking at the payment step: the PaymentIntent is made, and Stripe.js is confirming it. */
async function checkout(instantBook = true) {
  const booked = await book(instantBook);
  const payment = await booked.agent
    .post(`/api/v1/bookings/${booked.id}/payment`)
    .send({ acceptGuestAgreement: true });
  expect(payment.status).toBe(200);
  const pi = await PaymentModel.findOne({ bookingId: booked.id }).lean();
  return { ...booked, payment: pi!, piId: pi!.stripePaymentIntentId };
}

/** The 30 minutes are up: the booking's held dates no longer count. */
async function lapseHold(bookingId: string) {
  const past = new Date(Date.now() - MINUTE_MS);
  await BookingModel.updateOne({ _id: bookingId }, { $set: { holdExpiresAt: past } });
  await AvailabilityBlockModel.updateMany({ bookingId }, { $set: { expiresAt: past } });
}

/** Another Guest books overlapping dates on the same car. */
async function anotherGuestBooks(vehicleId: string) {
  const { agent } = await readyGuest('mere@example.co.nz', '+64223334444', 'CD654321');
  const created = await agent.post('/api/v1/bookings').send(tripDates(vehicleId, 11, 14));
  expect(created.status).toBe(201);
  return created.body.booking.id as string;
}

const succeeded = (piId: string, bookingId: string) => ({
  id: piId,
  object: 'payment_intent',
  status: 'succeeded',
  amount: 33_870,
  metadata: { bookingId },
});

const authorised = (piId: string, bookingId: string) => ({
  ...succeeded(piId, bookingId),
  status: 'requires_capture',
});

const unwantedJob = async () => {
  const job = await JobModel.findOne({ type: 'payment.refundUnwanted' }).lean();
  return job?.payload as { paymentId: string; reason?: UnwantedReason } | undefined;
};

// Bookings written straight to the database -------------------------------------------------------------------

async function parties() {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  return { host, guest, vehicle, ids: { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id } };
}

/** A Host with payouts set up, a Guest, and a paid, confirmed booking that started a day ago. */
async function confirmedTrip() {
  const { host, guest, vehicle } = await parties();
  await UserModel.updateOne(
    { _id: host._id },
    { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_host' } },
  );
  const startAt = new Date(Date.now() - 25 * HOUR_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { status: 'PAYMENT_PENDING', startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  const payment = await createPaymentRecord(booking);
  await withTransaction((session) => confirmBooking(booking, payment, session));
  return {
    host,
    guest,
    vehicle,
    booking: (await BookingModel.findById(booking._id))!,
    payment,
    payout: (await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' }))!,
  };
}

async function checkIn(bookingId: unknown, by: unknown) {
  await ConditionReportModel.create({
    bookingId,
    stage: 'CHECK_IN',
    submittedBy: by,
    odometer: 45_000,
    fuelOrBatteryPct: 80,
    photos: [],
  });
}

/** Another checked-in trip for the same Host, Guest and car, with its payout due now. */
async function anotherTrip({ host, guest, vehicle }: Awaited<ReturnType<typeof confirmedTrip>>) {
  const startAt = new Date(Date.now() - 10 * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { status: 'PAYMENT_PENDING', startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  const payment = await createPaymentRecord(booking);
  await withTransaction((session) => confirmBooking(booking, payment, session));
  await checkIn(booking._id, host._id);
  return { booking, payout: (await PayoutModel.findOne({ bookingId: booking._id, type: 'TRIP' }))! };
}

describe('staff cancellations', () => {
  const cancel = (agent: Agent, ref: string, reason: string, note = 'Spoke to both parties') =>
    agent.post(`/api/v1/admin/bookings/${ref}/cancel`).send({ reason, note });
  const preview = (agent: Agent, ref: string, reason: string) =>
    agent.get(`/api/v1/admin/bookings/${ref}/cancellation-preview`).query({ reason });

  it('treat a Guest no-show recorded after the start as a cancellation at the start time', async () => {
    const { ids } = await parties();
    // Flexible: 50 % back from the start time. Support records the no-show 3 hours after it.
    const startAt = new Date(Date.now() - 3 * HOUR_MS);
    const booking = await createBookingRecord(ids, {
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      cancellationPolicy: 'FLEXIBLE',
      cancellationTerms: FLEXIBLE,
    });
    const payment = await createPaymentRecord(booking);
    await createStaff();
    const admin = await staffAgent();

    // Half the rental ($133.50) and service fee ($13.35) back, with all of the protection.
    const previewed = await preview(admin, booking.ref, 'GUEST_NO_SHOW');
    expect(previewed.body).toMatchObject({
      allowed: true,
      kind: 'GUEST_CANCELLATION',
      refundPct: 50,
      hoursBeforeStart: 0,
      refundCents: 13_350 + 1_335 + 4_500,
      feeCents: 13_350 + 1_335,
      hostShareCents: 10_680,
      hostFeeCents: 0,
      releasedCents: 0,
    });
    expect(previewed.body.message).toBe(
      'A Guest cancellation at the start time, under the Flexible policy: the Guest gets $191.85 back and $146.85 is kept, of which the Host gets $106.80.',
    );

    const cancelled = await cancel(admin, booking.ref, 'GUEST_NO_SHOW', 'The Guest never arrived');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: {
        by: 'SUPPORT',
        reason: 'GUEST_NO_SHOW',
        refundCents: 19_185,
        feeCents: 14_685,
        hostShareCents: 10_680,
      },
    });
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: payment.stripePaymentIntentId, amount: 19_185 }),
      { idempotencyKey: `refund-${booking.id}-cancellation` },
    );
    // The Host is paid their share of the kept rental.
    expect(await PayoutModel.findOne({ bookingId: booking._id, type: 'CANCELLATION_FEE' })).toMatchObject({
      status: 'SCHEDULED',
      amountCents: 10_680,
    });
  });

  it('cancel for the Host as a Host cancellation, with the fee and the risk flag, but not a request', async () => {
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { cancellation: { hostCancellationFeeCents: 5_000 } },
    });
    const { host, ids } = await parties();
    // Two Host cancellations already in the last 90 days: the third raises the flag.
    for (const daysAgo of [20, 40]) {
      await createBookingRecord(ids, {
        status: 'CANCELLED',
        cancellationReason: 'HOST_CANCELLED',
        cancelledAt: new Date(Date.now() - daysAgo * DAY_MS),
      });
    }
    const booking = await createBookingRecord(ids, { startAt: new Date(Date.now() + 5 * DAY_MS) });
    const payment = await createPaymentRecord(booking);
    const pending = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() + DAY_MS),
    });
    await createPaymentRecord(pending, { status: 'AUTHORISED' });
    await createStaff();
    const admin = await staffAgent();

    expect((await preview(admin, booking.ref, 'HOST_CANCELLED')).body).toMatchObject({
      allowed: true,
      kind: 'HOST_CANCELLATION',
      refundCents: 33_870,
      feeCents: 0,
      hostFeeCents: 5_000,
    });
    const cancelled = await cancel(admin, booking.ref, 'HOST_CANCELLED', 'The Host’s car broke down');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { by: 'SUPPORT', reason: 'HOST_CANCELLED', refundCents: 33_870, hostFeeCents: 5_000 },
    });
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: payment.stripePaymentIntentId, amount: 33_870 }),
      expect.anything(),
    );
    expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
      status: 'REFUNDED',
      refunds: [expect.objectContaining({ amountCents: 33_870, kind: 'CANCELLATION', fundedBy: 'HOST' })],
    });
    expect((await BookingModel.findById(booking._id).lean())!.cancellationReason).toBe('HOST_CANCELLED');
    const updated = (await UserModel.findById(host._id).lean())!;
    expect(updated.hostProfile!.feesOwedCents).toBe(5_000);
    expect(updated.riskFlags).toEqual([
      expect.objectContaining({ code: 'HOST_CANCELLATIONS', detail: '3 Host cancellations in 90 days' }),
    ]);

    // A request isn't confirmed yet: only a platform cancellation applies, like a no-show.
    const request = await preview(admin, pending.ref, 'HOST_CANCELLED');
    expect(request.body).toMatchObject({ allowed: false, kind: null });
    expect(request.body.message).toMatch(/only to a confirmed booking/);
    const refused = await cancel(admin, pending.ref, 'HOST_CANCELLED');
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_CONFIRMED');
    expect((await BookingModel.findById(pending._id).lean())!.status).toBe('PENDING');
  });

  it('need the refunds permission only when they refund money', async () => {
    const { ids } = await parties();
    const pending = await createBookingRecord(ids, {
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() + DAY_MS),
      startAt: new Date(Date.now() + 20 * DAY_MS),
    });
    const authorisation = await createPaymentRecord(pending, { status: 'AUTHORISED' });
    const booking = await createBookingRecord(ids);
    const payment = await createPaymentRecord(booking);
    const member = await createStaff('sam@example.co.nz', 'SUPPORT');
    const support = await staffAgent('sam@example.co.nz');

    // A request was only authorised: support can cancel it, and the authorisation is released.
    const released = await cancel(support, pending.ref, 'PLATFORM', 'The Guest asked us to cancel');
    expect(released.status).toBe(200);
    expect(released.body.booking).toMatchObject({
      status: 'CANCELLED',
      cancellation: { by: 'SUPPORT', reason: 'PLATFORM', refundCents: 0 },
    });
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith(
      authorisation.stripePaymentIntentId,
      {},
      expect.anything(),
    );
    expect((await PaymentModel.findById(authorisation._id).lean())!.status).toBe('CANCELLED');
    expect(client.refunds.create).not.toHaveBeenCalled();

    // A paid booking would be refunded: not without the permission.
    const refusedPreview = await preview(support, booking.ref, 'PLATFORM');
    expect(refusedPreview.body).toMatchObject({
      allowed: false,
      kind: 'PLATFORM_CANCELLATION',
      refundCents: 33_870,
    });
    expect(refusedPreview.body.message).toMatch(/full refund/);
    expect(refusedPreview.body.message.endsWith(` ${NEEDS_REFUNDS_PERMISSION}`)).toBe(true);
    const refused = await cancel(support, booking.ref, 'PLATFORM', 'The car failed its WOF');
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(NEEDS_REFUNDS_PERMISSION);
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');
    expect(client.refunds.create).not.toHaveBeenCalled();

    // With the permission, support can.
    await UserModel.updateOne({ _id: member._id }, { $set: { permissions: ['REFUNDS'] } });
    expect((await preview(support, booking.ref, 'PLATFORM')).body).toMatchObject({
      allowed: true,
      refundCents: 33_870,
    });
    const cancelled = await cancel(support, booking.ref, 'PLATFORM', 'The car failed its WOF');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.cancellation).toMatchObject({ reason: 'PLATFORM', refundCents: 33_870 });
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('REFUNDED');

    // So can the admin.
    const another = await createBookingRecord(ids, { startAt: new Date(Date.now() + 30 * DAY_MS) });
    await createPaymentRecord(another);
    await createStaff();
    const admin = await staffAgent();
    const byAdmin = await cancel(admin, another.ref, 'HOST_NO_SHOW', 'The Host never turned up');
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.booking.cancellation).toMatchObject({ reason: 'HOST_NO_SHOW', refundCents: 33_870 });
  });
});

describe('a payment that arrives after its hold ran out', () => {
  it('is refunded in full when someone else booked the dates meanwhile, and the Guest is told why', async () => {
    const { id, piId, vehicle, guest } = await checkout();
    await lapseHold(id);
    const other = await anotherGuestBooks(vehicle.id);

    expect((await webhook('payment_intent.succeeded', succeeded(piId, id))).status).toBe(200);
    expect(await BookingModel.findById(id).lean()).toMatchObject({
      status: 'EXPIRED',
      paymentReturnedAt: expect.any(Date),
    });
    // The other Guest keeps the dates.
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
    expect(await AvailabilityBlockModel.countDocuments({ bookingId: other, reason: 'HOLD' })).toBe(1);
    const payment = (await PaymentModel.findOne({ bookingId: id }))!;
    expect(payment.status).toBe('SUCCEEDED');
    const job = await unwantedJob();
    expect(job).toEqual({ paymentId: payment.id, reason: 'DATES_TAKEN' });

    await refundUnwantedJob(job!, context);
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: piId, amount: 33_870 }),
      { idempotencyKey: `refund-${payment.id}-unwanted` },
    );
    expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
      status: 'REFUNDED',
      refunds: [
        expect.objectContaining({
          amountCents: 33_870,
          kind: 'LATE_PAYMENT',
          fundedBy: 'PLATFORM',
          reason: expect.stringMatching(/dates were booked by someone else/),
        }),
      ],
    });
    const email = await NotificationModel.findOne({
      userId: guest._id,
      type: 'REFUND_ISSUED',
      channel: 'EMAIL',
    }).lean();
    expect(email!.payload).toMatchObject({
      template: 'tripNotice',
      props: { heading: expect.stringMatching(/^\$338\.70 refunded: booking RV-\w+ wasn’t made$/) },
    });
    expect((email!.payload as { props: { paragraphs: string[] } }).props.paragraphs[0]).toMatch(
      /were booked by someone else while your payment was still being processed/,
    );

    // A retry finds it refunded and does nothing more.
    await refundUnwantedJob(job!, context);
    expect(client.refunds.create).toHaveBeenCalledTimes(1);
  });

  it('confirms the booking when the dates are still free', async () => {
    const { id, piId } = await checkout();
    await lapseHold(id);
    expect((await webhook('payment_intent.succeeded', succeeded(piId, id))).status).toBe(200);
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
    const blocks = await AvailabilityBlockModel.find({ bookingId: id }).lean();
    expect(blocks.map((block) => [block.reason, block.expiresAt]).sort()).toEqual([
      ['BOOKED', undefined],
      ['BUFFER', undefined],
    ]);
    expect(await unwantedJob()).toBeUndefined();
  });

  it('releases an authorisation instead of refunding when the request’s dates were taken', async () => {
    const { id, piId, vehicle, guest, host } = await checkout(false);
    await lapseHold(id);
    await anotherGuestBooks(vehicle.id);

    expect((await webhook('payment_intent.amount_capturable_updated', authorised(piId, id))).status).toBe(
      200,
    );
    expect((await BookingModel.findById(id).lean())!.status).toBe('EXPIRED');
    // The Host never gets a request for dates someone else has.
    expect(await NotificationModel.countDocuments({ userId: host._id, type: 'BOOKING_REQUEST' })).toBe(0);
    const payment = (await PaymentModel.findOne({ bookingId: id }))!;
    expect(payment.status).toBe('AUTHORISED');
    const job = await unwantedJob();
    expect(job).toEqual({ paymentId: payment.id, reason: 'DATES_TAKEN' });

    await refundUnwantedJob(job!, context);
    expect(client.paymentIntents.cancel).toHaveBeenCalledWith(piId, {}, { idempotencyKey: `cancel-${piId}` });
    expect(client.refunds.create).not.toHaveBeenCalled();
    expect((await PaymentModel.findById(payment._id).lean())!.status).toBe('CANCELLED');
    const told = await NotificationModel.findOne({
      userId: guest._id,
      type: 'BOOKING_EXPIRED',
      channel: 'IN_APP',
    }).lean();
    expect((told!.payload as { body: string }).body).toMatch(/The hold on your card is released/);
  });

  it('keeps the dates held a while longer while the bank is still processing it', async () => {
    const { id, vehicle } = await checkout();
    intentStatus = 'processing';
    const later = new Date(Date.now() + 31 * MINUTE_MS);
    expect(await expirePaymentHold(id, later)).toBe('waiting');
    expect((await BookingModel.findById(id).lean())!.status).toBe('PAYMENT_PENDING');
    const blocks = await AvailabilityBlockModel.find({ bookingId: id }).lean();
    expect(blocks.map((block) => block.reason).sort()).toEqual(['BUFFER', 'HOLD']);
    for (const block of blocks) {
      expect(block.expiresAt!.getTime()).toBe(later.getTime() + 15 * MINUTE_MS);
    }

    // Dates someone else booked once the hold ran out aren't taken back from them.
    await lapseHold(id);
    await anotherGuestBooks(vehicle.id);
    expect(await expirePaymentHold(id)).toBe('waiting');
    const lapsed = await AvailabilityBlockModel.find({ bookingId: id }).lean();
    for (const block of lapsed) expect(block.expiresAt!.getTime()).toBeLessThan(Date.now());
  });
});

describe('a suspended car', () => {
  const SUSPENSIONS: [string, Partial<Vehicle>][] = [
    ['the car', { status: 'SUSPENDED' }],
    ['its Host', { hostSuspended: true }],
  ];
  const suspend = (vehicleId: unknown, suspension: Partial<Vehicle>) =>
    VehicleModel.updateOne({ _id: vehicleId }, { $set: suspension });
  const lift = (vehicleId: unknown) =>
    VehicleModel.updateOne({ _id: vehicleId }, { $set: { status: 'ACTIVE', hostSuspended: false } });

  it('can’t have a request accepted until the suspension is lifted', async () => {
    const { id, ref, piId, vehicle, hostAgent } = await checkout(false);
    await webhook('payment_intent.amount_capturable_updated', authorised(piId, id));
    expect((await BookingModel.findById(id).lean())!.status).toBe('PENDING');

    for (const [, suspension] of SUSPENSIONS) {
      await suspend(vehicle._id, suspension);
      const refused = await hostAgent.post(`/api/v1/bookings/${ref}/accept`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('VEHICLE_SUSPENDED');
      await lift(vehicle._id);
    }
    expect(client.paymentIntents.capture).not.toHaveBeenCalled();
    expect((await BookingModel.findById(id).lean())!.status).toBe('PENDING');

    const accepted = await hostAgent.post(`/api/v1/bookings/${ref}/accept`);
    expect(accepted.body.booking.status).toBe('CONFIRMED');
  });

  it('can’t take a payment for a new booking', async () => {
    const { id, agent, vehicle } = await book();
    for (const [, suspension] of SUSPENSIONS) {
      await suspend(vehicle._id, suspension);
      const refused = await agent.post(`/api/v1/bookings/${id}/payment`).send({ acceptGuestAgreement: true });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('VEHICLE_SUSPENDED');
      await lift(vehicle._id);
    }
    expect(client.paymentIntents.create).not.toHaveBeenCalled();
  });

  for (const [who, suspension] of SUSPENSIONS) {
    it(`refunds a payment that went through after ${who} was suspended`, async () => {
      const { id, piId, vehicle } = await checkout();
      await suspend(vehicle._id, suspension);

      expect((await webhook('payment_intent.succeeded', succeeded(piId, id))).status).toBe(200);
      expect(await BookingModel.findById(id).lean()).toMatchObject({
        status: 'EXPIRED',
        paymentReturnedAt: expect.any(Date),
      });
      expect(await AvailabilityBlockModel.countDocuments({ bookingId: id })).toBe(0);
      const payment = (await PaymentModel.findOne({ bookingId: id }))!;
      const job = await unwantedJob();
      expect(job).toEqual({ paymentId: payment.id, reason: 'CAR_UNAVAILABLE' });

      await refundUnwantedJob(job!, context);
      expect(await PaymentModel.findById(payment._id).lean()).toMatchObject({
        status: 'REFUNDED',
        refunds: [
          expect.objectContaining({
            amountCents: 33_870,
            kind: 'LATE_PAYMENT',
            reason: expect.stringMatching(/car was suspended/),
          }),
        ],
      });
    });
  }
});

describe('a payment applied again after a cancellation', () => {
  it('isn’t refunded again: the cancellation decided what went back', async () => {
    const { booking, payment } = await confirmedTrip();
    // A policy cancellation that kept the whole payment (a non-refundable tier, or a no-show).
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: { status: 'CANCELLED', cancelledAt: new Date(), refundCents: 0 },
        $push: { statusHistory: { status: 'CANCELLED', at: new Date() } },
      },
    );

    // The same payment arrives again: a sync after Stripe.js, or a webhook Stripe sends again.
    const again = await webhook(
      'payment_intent.succeeded',
      succeeded(payment.stripePaymentIntentId, booking.id),
    );
    expect(again.status).toBe(200);
    expect(await unwantedJob()).toBeUndefined();
    expect((await BookingModel.findById(booking._id).lean())!.paymentReturnedAt).toBeUndefined();

    // Nor does a job queued some other way give it back.
    await refundUnwantedJob({ paymentId: payment.id }, context);
    expect(client.refunds.create).not.toHaveBeenCalled();
    expect((await PaymentModel.findById(payment._id).lean())!.refunds).toEqual([]);
  });
});

describe('a check approved while the car is suspended', () => {
  it('waits for the suspension to be lifted, then confirms the booking', async () => {
    const { id, ref, piId, guest, vehicle } = await checkout(false);
    await webhook('payment_intent.amount_capturable_updated', authorised(piId, id));
    // The Host accepted while the Guest's check was with support.
    await BookingModel.updateOne(
      { _id: id },
      { $set: { hostAcceptedAt: new Date(), verificationReview: { status: 'PENDING' } } },
    );
    await createStaff();
    const staff = await staffAgent();
    expect(
      (await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/suspend`).send({ reason: 'Recall notice' }))
        .status,
    ).toBe(200);

    const outcome = await resolveVerificationReview(guest.id, 'APPROVE', undefined);
    expect(outcome).toMatchObject({ confirmed: [], carSuspended: [ref] });
    expect(client.paymentIntents.capture).not.toHaveBeenCalled();
    expect(await BookingModel.findById(id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'APPROVED' },
    });

    expect((await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/unsuspend`)).status).toBe(200);
    expect(client.paymentIntents.capture).toHaveBeenCalledTimes(1);
    expect((await BookingModel.findById(id).lean())!.status).toBe('CONFIRMED');
  });
});

describe('Host-funded refunds larger than the trip’s payout', () => {
  it('take the whole payout, and the rest comes off the next one', async () => {
    const parts = await confirmedTrip();
    await checkIn(parts.booking._id, parts.host._id);
    await createStaff();
    const admin = await staffAgent();
    const refunded = await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
      .send({ amountCents: 25_000, reason: 'The car broke down on the first day', fundedBy: 'HOST' });
    expect(refunded.status).toBe(200);
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'THIS_PAYOUT' });

    expect(await runPayout(parts.payout.id)).toBe('paid');
    expect(transfers).toHaveLength(0);
    const paid = await PayoutModel.findById(parts.payout._id).lean();
    expect(paid).toMatchObject({ status: 'PAID', amountCents: 0 });
    expect(paid!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_FUNDED_REFUND', stripeRefundId: 're_1', amountCents: 21_360 }),
    ]);
    expect(await refundsOwed(parts.host._id)).toEqual([
      expect.objectContaining({
        stripeRefundId: 're_1',
        amountCents: 25_000 - 21_360,
        bookingId: parts.booking._id,
      }),
    ]);

    const next = await anotherTrip(parts);
    expect(await runPayout(next.payout.id)).toBe('paid');
    expect(transfers.map((transfer) => transfer.amount)).toEqual([21_360 - 3_640]);
    expect((await PayoutModel.findById(next.payout._id).lean())!.deductions).toEqual([
      expect.objectContaining({
        type: 'HOST_FUNDED_REFUND',
        stripeRefundId: 're_1',
        amountCents: 3_640,
        owed: true,
      }),
    ]);
    expect(await refundsOwed(parts.host._id)).toEqual([]);
  });
});

describe('refunds of extra charges', () => {
  /** A paid extra charge on the trip, with the Host's share of it still to be sent. */
  async function paidCharge() {
    const parts = await confirmedTrip();
    await checkIn(parts.booking._id, parts.host._id);
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
    await createStaff();
    const admin = await staffAgent();
    const refund = (body: Record<string, unknown>) =>
      admin
        .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
        .send({ paymentId: charge.id, amountCents: 500, reason: 'The odometer was misread', ...body });
    return { ...parts, charge, chargePayout, admin, refund };
  }

  it('are listed with the booking, and a platform-funded one leaves the payouts alone', async () => {
    const { booking, payment, charge, chargePayout, admin, refund } = await paidCharge();
    const detail = await admin.get(`/api/v1/admin/bookings/${booking.ref}`);
    expect(detail.body.refundableCharges).toEqual([
      {
        paymentId: charge.id,
        type: 'EXTRA_KM',
        description: '50 km over the 750 km included',
        refundableCents: 1_750,
        payoutSent: false,
      },
    ]);

    const refunded = await refund({ fundedBy: 'PLATFORM' });
    expect(refunded.status).toBe(200);
    expect(refunded.body.hostRefund).toBeUndefined();
    expect(client.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: charge.stripePaymentIntentId, amount: 500 }),
      expect.anything(),
    );
    expect(await PaymentModel.findById(charge._id).lean()).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refunds: [expect.objectContaining({ amountCents: 500, kind: 'STAFF', fundedBy: 'PLATFORM' })],
    });
    // The booking's own payment isn't touched.
    expect((await PaymentModel.findById(payment._id).lean())!.refunds).toEqual([]);
    expect(refunded.body.refundableCents).toBe(33_870);
    expect(refunded.body.refundableCharges[0]).toMatchObject({ refundableCents: 1_250, payoutSent: false });

    expect(await runPayout(chargePayout.id)).toBe('paid');
    expect(transfers.at(-1)!.amount).toBe(1_400);
    expect((await PayoutModel.findById(chargePayout._id).lean())!.deductions).toEqual([]);
  });

  it('come off the charge’s own payout when the Host funds one before it’s sent', async () => {
    const { host, payout, chargePayout, refund } = await paidCharge();
    const refunded = await refund({ fundedBy: 'HOST' });
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'THIS_PAYOUT' });
    expect(await refundsOwed(host._id)).toEqual([]);

    expect(await runPayout(chargePayout.id)).toBe('paid');
    expect((await PayoutModel.findById(chargePayout._id).lean())!.deductions).toEqual([
      expect.objectContaining({ type: 'HOST_FUNDED_REFUND', stripeRefundId: 're_1', amountCents: 500 }),
    ]);
    expect(transfers.at(-1)!.amount).toBe(1_400 - 500);
    // The trip's own payout doesn't take it again.
    expect(await runPayout(payout.id)).toBe('paid');
    expect((await PayoutModel.findById(payout._id).lean())!.deductions).toEqual([]);
    expect(transfers.at(-1)!.amount).toBe(21_360);
  });

  it('are owed by the Host, or taken back from the charge’s transfer, once its payout is sent', async () => {
    const { booking, host, payout, chargePayout, admin, refund } = await paidCharge();
    // The trip's transfer is tr_1, the charge's tr_2.
    expect(await runPayout(payout.id)).toBe('paid');
    expect(await runPayout(chargePayout.id)).toBe('paid');
    const detail = await admin.get(`/api/v1/admin/bookings/${booking.ref}`);
    expect(detail.body.refundableCharges[0]).toMatchObject({ payoutSent: true });

    const owed = await refund({ fundedBy: 'HOST' });
    expect(owed.body.hostRefund).toEqual({ recoveredFrom: 'NEXT_PAYOUT', owedCents: 500 });
    expect(await refundsOwed(host._id)).toEqual([
      expect.objectContaining({ stripeRefundId: 're_1', amountCents: 500, bookingId: booking._id }),
    ]);
    const told = await NotificationModel.findOne({
      userId: host._id,
      type: 'HOST_REFUND_RECOVERED',
      channel: 'EMAIL',
    }).lean();
    expect((told!.payload as { props: { paragraphs: string[] } }).props.paragraphs[0]).toContain(
      'a refund of an extra charge you were paid',
    );

    const reversal = vi
      .spyOn(client.transfers, 'createReversal')
      .mockResolvedValueOnce({ id: 'trr_1' } as Stripe.Response<Stripe.TransferReversal>);
    const reversed = await refund({ fundedBy: 'HOST', amountCents: 300, recoverFrom: 'REVERSE_TRANSFER' });
    expect(reversed.body.hostRefund).toEqual({ recoveredFrom: 'REVERSE_TRANSFER', reversedCents: 300 });
    expect(reversal).toHaveBeenCalledWith('tr_2', expect.objectContaining({ amount: 300 }), {
      idempotencyKey: 'reversal-re_2',
    });
    expect((await PayoutModel.findById(chargePayout._id).lean())!.reversals).toEqual([
      expect.objectContaining({ stripeReversalId: 'trr_1', amountCents: 300, stripeRefundId: 're_2' }),
    ]);
    expect((await PayoutModel.findById(payout._id).lean())!.reversals).toEqual([]);
    expect(await refundsOwed(host._id)).toHaveLength(1);
  });

  it('refuse a payment from another booking', async () => {
    const { booking, host, guest, vehicle, admin } = await paidCharge();
    const otherBooking = await createBookingRecord({
      guestId: guest._id,
      hostId: host._id,
      vehicleId: vehicle._id,
    });
    const otherPayment = await createPaymentRecord(otherBooking);
    const refused = await admin
      .post(`/api/v1/admin/bookings/${booking.ref}/refunds`)
      .send({ paymentId: otherPayment.id, amountCents: 500, reason: 'Wrong booking', fundedBy: 'PLATFORM' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NOT_PAID');
    expect(client.refunds.create).not.toHaveBeenCalled();
  });
});

describe('a refund Stripe refuses straight away', () => {
  it('alerts staff, and the Host owes nothing for it', async () => {
    const parts = await confirmedTrip();
    await checkIn(parts.booking._id, parts.host._id);
    expect(await runPayout(parts.payout.id)).toBe('paid');
    const staff = await createStaff();
    const admin = await staffAgent();

    refundStatus = 'failed';
    const refunded = await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'Car was not cleaned', fundedBy: 'HOST' });
    expect(refunded.status).toBe(200);
    expect(refunded.body.hostRefund).toBeUndefined();
    expect(await refundsOwed(parts.host._id)).toEqual([]);
    expect(
      await NotificationModel.countDocuments({ userId: parts.host._id, type: 'HOST_REFUND_RECOVERED' }),
    ).toBe(0);
    expect(await PaymentModel.findById(parts.payment._id).lean()).toMatchObject({
      status: 'SUCCEEDED',
      refunds: [
        expect.objectContaining({
          amountCents: 5_000,
          status: 'FAILED',
          failureReason: 'expired_or_canceled_card',
        }),
      ],
    });
    expect(refunded.body.refundableCents).toBe(33_870);

    const alert = await NotificationModel.findOne({
      userId: staff._id,
      type: 'REFUND_FAILED',
      channel: 'IN_APP',
    }).lean();
    expect((alert!.payload as { body: string }).body).toMatch(
      /refund of \$50\.00 failed \(expired_or_canceled_card\)/,
    );
  });

  // Stripe refused it at once: staff are alerted, and the Guest isn't told it's on its way.
  it('isn’t announced to the Guest as refunded', async () => {
    const parts = await confirmedTrip();
    await createStaff();
    const admin = await staffAgent();
    refundStatus = 'failed';
    const refunded = await admin
      .post(`/api/v1/admin/bookings/${parts.booking.ref}/refunds`)
      .send({ amountCents: 5_000, reason: 'Car was not cleaned', fundedBy: 'PLATFORM' });
    expect(refunded.status).toBe(200);
    expect(await NotificationModel.countDocuments({ userId: parts.guest._id, type: 'REFUND_ISSUED' })).toBe(
      0,
    );
  });
});

describe('waiving Host cancellation fees', () => {
  it('takes the newest fees first, and earnings and the statement show what’s left', async () => {
    const { host, ids } = await parties();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 10_000 } });
    const startAt = new Date(Date.now() + 10 * DAY_MS);
    const cancelledHostFee = (daysAgo: number) =>
      createBookingRecord(ids, {
        status: 'CANCELLED',
        startAt,
        cancelledAt: new Date(Date.now() - daysAgo * DAY_MS),
        cancellationReason: 'HOST_CANCELLED',
        refundCents: 33_870,
        hostShareCents: 0,
        hostCancellationFeeCents: 5_000,
      });
    const older = await cancelledHostFee(10);
    const newer = await cancelledHostFee(2);
    await createStaff();
    const admin = await staffAgent();
    const waive = (body: Record<string, unknown>) =>
      admin
        .post(`/api/v1/admin/users/${host.id}/waive-host-fee`)
        .send({ reason: 'Cancelled for a medical emergency', ...body });

    const part = await waive({ amountCents: 3_000 });
    expect(part.status).toBe(200);
    expect(part.body.user.host.feesOwedCents).toBe(7_000);
    expect((await BookingModel.findById(newer._id).lean())!.hostCancellationFeeWaivedCents).toBe(3_000);
    expect((await BookingModel.findById(older._id).lean())!.hostCancellationFeeWaivedCents).toBeUndefined();

    const agent = await signIn(host.email);
    const rows = (await agent.get('/api/v1/host/earnings')).body.bookings as {
      ref: string;
      hostCancellationFeeCents: number;
      netCents: number;
    }[];
    expect(rows.find((row) => row.ref === newer.ref)).toMatchObject({
      hostCancellationFeeCents: 2_000,
      netCents: -2_000,
    });
    expect(rows.find((row) => row.ref === older.ref)).toMatchObject({
      hostCancellationFeeCents: 5_000,
      netCents: -5_000,
    });
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' })
      .format(startAt)
      .slice(0, 7);
    const statement = await agent.get('/api/v1/host/earnings/statement').query({ period: month });
    expect(statement.text).toContain(
      `${newer.ref},2021 Toyota Corolla,CANCELLED,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,20.00,-20.00`,
    );
    expect(statement.text).toContain(
      `${older.ref},2021 Toyota Corolla,CANCELLED,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,50.00,-50.00`,
    );

    // The rest: what's left of the newer fee, then the older one.
    const rest = await waive({});
    expect(rest.body.user.host.feesOwedCents).toBe(0);
    expect((await BookingModel.findById(newer._id).lean())!.hostCancellationFeeWaivedCents).toBe(5_000);
    expect((await BookingModel.findById(older._id).lean())!.hostCancellationFeeWaivedCents).toBe(5_000);
    const after = (await agent.get('/api/v1/host/earnings')).body.bookings as {
      hostCancellationFeeCents: number;
    }[];
    expect(after.reduce((sum, row) => sum + row.hostCancellationFeeCents, 0)).toBe(0);
  });
});

describe('earnings', () => {
  it('count lifetime totals only to the end of this month', async () => {
    const { host, ids } = await parties();
    const past = new Date(Date.now() - 5 * DAY_MS);
    await createBookingRecord(ids, {
      status: 'COMPLETED',
      startAt: past,
      endAt: new Date(past.getTime() + 3 * DAY_MS),
    });
    const nextYear = new Date(Date.now() + 400 * DAY_MS);
    await createBookingRecord(ids, { startAt: nextYear, endAt: new Date(nextYear.getTime() + 3 * DAY_MS) });

    const agent = await signIn(host.email);
    const earnings = await agent.get('/api/v1/host/earnings');
    expect(earnings.status).toBe(200);
    expect(earnings.body.summary).toMatchObject({
      lifetimeCents: 21_360,
      platformFeesLifetimeCents: 5_340,
    });
  });

  it('take a Host-funded staff refund off a cancelled booking, but not its cancellation refund', async () => {
    const { host, ids } = await parties();
    const startAt = new Date(Date.now() - 5 * DAY_MS);
    const booking = await createBookingRecord(ids, {
      status: 'CANCELLED',
      startAt,
      endAt: new Date(startAt.getTime() + 3 * DAY_MS),
      cancelledAt: new Date(startAt.getTime() - 2 * DAY_MS),
      cancellationReason: 'GUEST_CANCELLED',
      refundCents: 19_185,
      cancellationFeeCents: 14_685,
      hostShareCents: 10_680,
    });
    const at = new Date();
    await createPaymentRecord(booking, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 19_185,
          reason: 'Cancellation (GUEST_CANCELLED)',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: at,
        },
        {
          amountCents: 2_000,
          reason: 'The Host was rude to the Guest',
          kind: 'STAFF',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: at,
        },
        {
          amountCents: 1_000,
          reason: 'Goodwill',
          kind: 'STAFF',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: at,
        },
      ],
    });

    const agent = await signIn(host.email);
    const earnings = await agent.get('/api/v1/host/earnings');
    // The kept rental ($133.50) less its commission, less the $20 the Host funded.
    expect(earnings.body.bookings).toEqual([
      expect.objectContaining({
        ref: booking.ref,
        keptFeeCents: 13_350,
        commissionCents: 2_670,
        hostFundedRefundsCents: 2_000,
        netCents: 13_350 - 2_670 - 2_000,
      }),
    ]);
  });
});

describe('payouts and the Host’s payout setup', () => {
  it('are held as soon as Stripe pauses the Host’s payouts, and released when it’s sorted', async () => {
    const { host, ids } = await parties();
    await UserModel.updateOne(
      { _id: host._id },
      { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_host' } },
    );
    const upcoming = await createBookingRecord(ids);
    const finished = await createBookingRecord(ids, { status: 'COMPLETED' });
    const scheduled = await PayoutModel.create({
      hostId: host._id,
      bookingId: upcoming._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'SCHEDULED',
      scheduledFor: new Date(Date.now() + 11 * DAY_MS),
    });
    const paid = await PayoutModel.create({
      hostId: host._id,
      bookingId: finished._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'PAID',
      scheduledFor: new Date(Date.now() - 5 * DAY_MS),
      paidAt: new Date(Date.now() - 5 * DAY_MS),
    });
    const account = (enabled: boolean) => ({
      id: 'acct_host',
      object: 'account',
      payouts_enabled: enabled,
      capabilities: { transfers: enabled ? 'active' : 'inactive' },
      requirements: { currently_due: enabled ? [] : ['external_account'], past_due: [] },
    });

    expect((await webhook('account.updated', account(false), 'whsec_connect')).status).toBe(200);
    expect((await UserModel.findById(host._id).lean())!.hostProfile!.payoutsEnabled).toBe(false);
    expect(await PayoutModel.findById(scheduled._id).lean()).toMatchObject({
      status: 'HELD',
      holdReason: 'PAYOUT_SETUP',
    });
    expect((await PayoutModel.findById(paid._id).lean())!.status).toBe('PAID');
    expect(
      await NotificationModel.countDocuments({ userId: host._id, type: 'PAYOUT_SETUP_NEEDED' }),
    ).toBeGreaterThan(0);
    const agent = await signIn(host.email);
    const listed = (await agent.get('/api/v1/host/payouts')).body.payouts;
    expect(listed.find((payout: { id: string }) => payout.id === scheduled.id)).toMatchObject({
      status: 'HELD',
      holdReason: 'PAYOUT_SETUP',
    });

    expect((await webhook('account.updated', account(true), 'whsec_connect')).status).toBe(200);
    const released = await PayoutModel.findById(scheduled._id).lean();
    expect(released!.status).toBe('SCHEDULED');
    expect(released!.holdReason).toBeUndefined();
  });

  it('show when a scheduled payout should reach the bank, in business days after it’s sent', async () => {
    const { host, ids } = await parties();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.payoutDelayDays': 2 } });
    // Friday 16 October 2026, 2 pm in Auckland: two business days on is Tuesday.
    const friday = new Date('2026-10-16T01:00:00.000Z');
    const scheduled = await PayoutModel.create({
      hostId: host._id,
      bookingId: (await createBookingRecord(ids))._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'SCHEDULED',
      scheduledFor: friday,
    });
    const held = await PayoutModel.create({
      hostId: host._id,
      bookingId: (await createBookingRecord(ids))._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'HELD',
      holdReason: 'INCIDENT',
      scheduledFor: friday,
    });

    const agent = await signIn(host.email);
    const payouts = (await agent.get('/api/v1/host/payouts')).body.payouts as { id: string }[];
    expect(payouts.find((payout) => payout.id === scheduled.id)).toMatchObject({
      status: 'SCHEDULED',
      scheduledFor: friday.toISOString(),
      expectedInBankBy: '2026-10-20T01:00:00.000Z',
    });
    // A held payout has no date until it's released.
    expect(payouts.find((payout) => payout.id === held.id)).not.toHaveProperty('expectedInBankBy');
  });
});

describe('booking lists', () => {
  it('leave a checkout the Guest never paid for out of their cancelled trips', async () => {
    const { host, guest, ids } = await parties();
    await createBookingRecord(ids, { status: 'EXPIRED' });
    const lapsedRequest = await createBookingRecord(ids, {
      status: 'EXPIRED',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() - HOUR_MS),
    });
    const returned = await createBookingRecord(ids, {
      status: 'EXPIRED',
      paymentReturnedAt: new Date(Date.now() - HOUR_MS),
    });

    const refs = (body: { bookings: { ref: string }[] }) => body.bookings.map((row) => row.ref).sort();
    const guestAgent = await signIn(guest.email);
    expect(refs((await guestAgent.get('/api/v1/bookings').query({ group: 'cancelled' })).body)).toEqual(
      [lapsedRequest.ref, returned.ref].sort(),
    );
    // The Host only ever heard of the request.
    const hostAgent = await signIn(host.email);
    expect(
      refs((await hostAgent.get('/api/v1/bookings').query({ role: 'host', group: 'cancelled' })).body),
    ).toEqual([lapsedRequest.ref]);
  });

  it('show the Host each Guest’s verification, rating and trips, and the Guest none of that', async () => {
    const { host, guest, vehicle, ids } = await parties();
    await UserModel.updateOne(
      { _id: guest._id },
      { $set: { identityVerification: { status: 'APPROVED', verifiedAt: new Date() } } },
    );
    const past = new Date(Date.now() - 30 * DAY_MS);
    const completed: Awaited<ReturnType<typeof createBookingRecord>>[] = [];
    for (let trip = 0; trip < 3; trip += 1) {
      completed.push(
        await createBookingRecord(ids, {
          status: 'COMPLETED',
          startAt: new Date(past.getTime() + trip * 5 * DAY_MS),
          endAt: new Date(past.getTime() + (trip * 5 + 3) * DAY_MS),
        }),
      );
    }
    // Two published reviews of the Guest count; one still waiting to be revealed, and one of the Host, don't.
    const review = (index: number, overall: number, extra: Record<string, unknown> = {}) => ({
      bookingId: completed[index]!._id,
      vehicleId: vehicle._id,
      authorId: host._id,
      subjectId: guest._id,
      direction: 'HOST_TO_GUEST',
      overall,
      status: 'PUBLISHED',
      ...extra,
    });
    await ReviewModel.create([
      review(0, 5),
      review(1, 4),
      review(2, 1, { status: 'AWAITING_REVEAL' }),
      review(0, 2, { direction: 'GUEST_TO_HOST', authorId: guest._id, subjectId: host._id }),
    ]);
    const upcoming = await createBookingRecord(ids);
    const newcomer = await createUser({ email: 'mere@example.co.nz', firstName: 'Mere' });
    const newcomerBooking = await createBookingRecord({ ...ids, guestId: newcomer._id });

    const hostAgent = await signIn(host.email);
    const hostRows = (await hostAgent.get('/api/v1/bookings').query({ role: 'host', group: 'upcoming' })).body
      .bookings as { ref: string; otherParty: object }[];
    expect(hostRows.find((row) => row.ref === upcoming.ref)!.otherParty).toEqual({
      firstName: 'Kiri',
      verified: true,
      rating: { avg: 4.5, count: 2 },
      tripCount: 3,
    });
    expect(hostRows.find((row) => row.ref === newcomerBooking.ref)!.otherParty).toEqual({
      firstName: 'Mere',
      verified: false,
      rating: { avg: 0, count: 0 },
      tripCount: 0,
    });

    const guestAgent = await signIn(guest.email);
    const guestRows = (await guestAgent.get('/api/v1/bookings').query({ group: 'upcoming' })).body.bookings;
    expect(guestRows.find((row: { ref: string }) => row.ref === upcoming.ref).otherParty).toEqual({
      firstName: 'Hana',
    });
  });
});

describe('closing an account', () => {
  it('waits for a failed payout, which is still owed to the Host', async () => {
    const { host, ids } = await parties();
    const booking = await createBookingRecord(ids, {
      status: 'COMPLETED',
      startAt: new Date(Date.now() - 10 * DAY_MS),
      endAt: new Date(Date.now() - 7 * DAY_MS),
    });
    const payout = await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21_360,
      status: 'FAILED',
      failureReason: 'The destination account needs transfers enabled',
      scheduledFor: new Date(Date.now() - 9 * DAY_MS),
    });

    const agent = await signIn(host.email);
    const closure = await agent.get('/api/v1/me/account-closure');
    expect(closure.body).toMatchObject({ allowed: false, blockers: [{ code: 'PAYOUT_DUE' }] });

    await PayoutModel.updateOne({ _id: payout._id }, { $set: { status: 'PAID', paidAt: new Date() } });
    expect((await agent.get('/api/v1/me/account-closure')).body).toEqual({ allowed: true, blockers: [] });
  });
});
