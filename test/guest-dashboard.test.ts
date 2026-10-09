import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripe } from '../src/integrations/stripe.js';
import { JobModel } from '../src/jobs/job.model.js';
import { forget } from '../src/lib/memo.js';
import { fromNzWallClock, parseNzDateTime } from '../src/lib/nz-time.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { HelpArticleModel } from '../src/modules/help/help-article.model.js';
import { articleSummary } from '../src/modules/help/help.routes.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle, nzDay } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser } from './helpers.js';

/*
 * The Guest dashboard's account pages (plan §9, Days 16–18; spec §8): Saved cars, saved cards and
 * payment history, receipts, privacy requests, the help centre and the user's own support tickets.
 */

const client = stripe();
const DAY_MS = 24 * 60 * 60 * 1000;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A Host with a live car, and a Guest who booked it. */
async function bookedTrip(overrides: Parameters<typeof createBookingRecord>[1] = {}) {
  const host = await createHost();
  const vehicle = await createVehicle(host._id);
  const guest = await createUser({ firstName: 'Kiri' });
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    overrides,
  );
  return { host, vehicle, guest, booking };
}

beforeEach(() => forget());
afterEach(() => vi.restoreAllMocks());

describe('Saved cars', () => {
  it('prices each saved car for the last searched dates, most recently saved first', async () => {
    const host = await createHost();
    const yaris = await createVehicle(host._id, { make: 'Toyota', model: 'Yaris' });
    const mazda = await createVehicle(host._id, { make: 'Mazda', model: 'CX-5' });
    const guest = await createUser();
    const agent = await signIn(guest.email);
    expect((await agent.put(`/api/v1/me/favourites/${yaris.id}`)).status).toBe(204);
    expect((await agent.put(`/api/v1/me/favourites/${mazda.id}`)).status).toBe(204);
    const search = { place: 'Auckland', start: nzDay(10), end: nzDay(13) };
    expect((await agent.put('/api/v1/me/last-search').send(search)).status).toBe(204);

    const saved = await agent.get('/api/v1/me/saved-cars');
    expect(saved.status).toBe(200);
    expect(saved.body.search).toEqual({
      place: 'Auckland',
      start: parseNzDateTime(search.start)!.toISOString(),
      end: parseNzDateTime(search.end)!.toISOString(),
      days: 3,
    });
    expect(saved.body.cars.map((car: { id: string }) => car.id)).toEqual([mazda.id, yaris.id]);
    // 3 days at $89, the 10 % service fee and the $15 Basic plan.
    expect(saved.body.cars[0]).toMatchObject({
      title: '2021 Mazda CX-5',
      listed: true,
      availableForDates: true,
      estimate: { days: 3, totalCents: 33_870, includesAirportDelivery: false },
    });
  });

  it('says which cars are taken, taken down or outside their rules for those dates, with no estimate', async () => {
    const host = await createHost();
    const taken = await createVehicle(host._id, { model: 'Taken' });
    const hidden = await createVehicle(host._id, { model: 'Hidden', status: 'INACTIVE' });
    const longTrips = await createVehicle(host._id, {
      model: 'Week',
      rules: {
        minDays: 5,
        maxDays: 30,
        minNoticeHours: 4,
        bufferHours: 2,
        instantBook: true,
        cancellationTier: 'MODERATE',
      },
    });
    const deleted = await createVehicle(host._id, { model: 'Gone' });
    const guest = await createUser();
    await UserModel.updateOne(
      { _id: guest._id },
      {
        $set: {
          favouriteVehicleIds: [taken._id, hidden._id, longTrips._id, deleted._id],
          lastSearch: { startAt: parseNzDateTime(nzDay(10)), endAt: parseNzDateTime(nzDay(13)) },
        },
      },
    );
    await AvailabilityBlockModel.create({
      vehicleId: taken._id,
      startAt: parseNzDateTime(nzDay(11)),
      endAt: parseNzDateTime(nzDay(12)),
      reason: 'HOST_BLOCK',
    });
    await VehicleModel.deleteOne({ _id: deleted._id });

    const saved = await (await signIn(guest.email)).get('/api/v1/me/saved-cars');
    const byModel = Object.fromEntries(
      saved.body.cars.map((car: { model: string }) => [car.model, car]),
    ) as Record<string, { listed: boolean; availableForDates: boolean | null; estimate: unknown }>;
    expect(Object.keys(byModel).sort()).toEqual(['Hidden', 'Taken', 'Week']);
    expect(byModel.Taken).toMatchObject({ listed: true, availableForDates: false, estimate: null });
    expect(byModel.Hidden).toMatchObject({ listed: false, availableForDates: false, estimate: null });
    expect(byModel.Week).toMatchObject({ listed: true, availableForDates: false, estimate: null });
  });

  it('has no dates once the searched pick-up has passed', async () => {
    const host = await createHost();
    const car = await createVehicle(host._id);
    const guest = await createUser();
    await UserModel.updateOne(
      { _id: guest._id },
      {
        $set: {
          favouriteVehicleIds: [car._id],
          lastSearch: { startAt: new Date(Date.now() - DAY_MS), endAt: new Date(Date.now() + DAY_MS) },
        },
      },
    );
    const saved = await (await signIn(guest.email)).get('/api/v1/me/saved-cars');
    expect(saved.body.search).toBeNull();
    expect(saved.body.cars[0]).toMatchObject({ listed: true, availableForDates: null, estimate: null });
  });

  it('needs an account', async () => {
    expect((await browserAgent().get('/api/v1/me/saved-cars')).status).toBe(401);
  });
});

function paymentMethod(id: string, card: Partial<Stripe.PaymentMethod.Card> = {}, customer = 'cus_1') {
  return {
    id,
    object: 'payment_method',
    customer,
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2099, wallet: null, ...card },
  } as unknown as Stripe.PaymentMethod;
}

describe('Saved cards', () => {
  it('lists the Guest’s cards, marking wallets and expired cards', async () => {
    const guest = await createUser();
    await UserModel.updateOne({ _id: guest._id }, { $set: { stripeCustomerId: 'cus_1' } });
    const list = vi.spyOn(client.customers, 'listPaymentMethods').mockResolvedValue({
      data: [
        paymentMethod('pm_visa'),
        paymentMethod('pm_old', { brand: 'mastercard', last4: '4444', exp_month: 1, exp_year: 2020 }),
        paymentMethod('pm_wallet', { wallet: { type: 'apple_pay' } as Stripe.PaymentMethod.Card.Wallet }),
      ],
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.PaymentMethod>>);

    const cards = await (await signIn(guest.email)).get('/api/v1/me/payment-methods');
    expect(cards.status).toBe(200);
    expect(list).toHaveBeenCalledWith('cus_1', { type: 'card', limit: 20 });
    expect(cards.body.cards).toEqual([
      { id: 'pm_visa', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2099, expired: false },
      { id: 'pm_old', brand: 'mastercard', last4: '4444', expMonth: 1, expYear: 2020, expired: true },
      {
        id: 'pm_wallet',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2099,
        expired: false,
        wallet: 'apple_pay',
      },
    ]);
  });

  it('has none before the first payment, without asking Stripe', async () => {
    const guest = await createUser();
    const list = vi.spyOn(client.customers, 'listPaymentMethods');
    const cards = await (await signIn(guest.email)).get('/api/v1/me/payment-methods');
    expect(cards.body).toEqual({ cards: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it('saves a card with a SetupIntent on the Guest’s new Stripe customer', async () => {
    const guest = await createUser();
    const customer = vi
      .spyOn(client.customers, 'create')
      .mockResolvedValue({ id: 'cus_new' } as Stripe.Response<Stripe.Customer>);
    const setup = vi
      .spyOn(client.setupIntents, 'create')
      .mockResolvedValue({ client_secret: 'seti_secret' } as Stripe.Response<Stripe.SetupIntent>);

    const started = await (await signIn(guest.email)).post('/api/v1/me/payment-methods/setup');
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ clientSecret: 'seti_secret' });
    expect(customer).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_new', usage: 'off_session' }),
    );
    expect((await UserModel.findById(guest._id).lean())?.stripeCustomerId).toBe('cus_new');
  });

  it('removes only the Guest’s own cards', async () => {
    const guest = await createUser();
    await UserModel.updateOne({ _id: guest._id }, { $set: { stripeCustomerId: 'cus_1' } });
    vi.spyOn(client.paymentMethods, 'retrieve').mockImplementation(async (id) =>
      id === 'pm_mine'
        ? (paymentMethod('pm_mine') as Stripe.Response<Stripe.PaymentMethod>)
        : (paymentMethod(String(id), {}, 'cus_someone_else') as Stripe.Response<Stripe.PaymentMethod>),
    );
    const detach = vi
      .spyOn(client.paymentMethods, 'detach')
      .mockResolvedValue({} as Stripe.Response<Stripe.PaymentMethod>);
    const agent = await signIn(guest.email);

    expect((await agent.delete('/api/v1/me/payment-methods/pm_theirs')).status).toBe(404);
    expect((await agent.delete('/api/v1/me/payment-methods/not-a-card')).status).toBe(404);
    expect(detach).not.toHaveBeenCalled();
    expect((await agent.delete('/api/v1/me/payment-methods/pm_mine')).status).toBe(204);
    expect(detach).toHaveBeenCalledWith('pm_mine');
  });
});

describe('Payment history', () => {
  it('lists what the Guest paid, with refunds, and leaves out attempts that charged nothing', async () => {
    const { host, vehicle, guest, booking } = await bookedTrip();
    const refunded = await createPaymentRecord(booking, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 10_000,
          reason: 'Cancellation',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: new Date(),
        },
      ],
    });
    const request = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'PENDING', instantBook: false },
    );
    const authorised = await createPaymentRecord(request, { status: 'AUTHORISED', method: undefined });
    // A card that was declined at checkout, a payment never finished and a released authorisation.
    await createPaymentRecord(request, { status: 'FAILED', failureReason: 'Your card was declined.' });
    await createPaymentRecord(request, { status: 'PENDING' });
    await createPaymentRecord(request, { status: 'CANCELLED' });
    // Someone else's.
    const other = await createUser({ email: 'mere@example.co.nz' });
    await createPaymentRecord(
      await createBookingRecord({ guestId: other._id, hostId: host._id, vehicleId: vehicle._id }),
    );

    const history = await (await signIn(guest.email)).get('/api/v1/me/payments');
    expect(history.status).toBe(200);
    const byId = Object.fromEntries(
      history.body.payments.map((payment: { id: string }) => [payment.id, payment]),
    );
    expect(Object.keys(byId).sort()).toEqual([authorised.id, refunded.id].sort());
    expect(byId[refunded.id]).toMatchObject({
      bookingRef: booking.ref,
      vehicleTitle: '2021 Toyota Corolla',
      type: 'BOOKING',
      amountCents: 33_870,
      status: 'PARTIALLY_REFUNDED',
      method: 'Visa ending 4242',
      refundedCents: 10_000,
      refunds: [{ amountCents: 10_000, status: 'SUCCEEDED' }],
      hasReceipt: true,
    });
    expect(byId[authorised.id]).toMatchObject({ status: 'AUTHORISED', hasReceipt: false, refundedCents: 0 });
    expect(byId[authorised.id]).not.toHaveProperty('method');
  });

  it('is empty for someone who has never booked', async () => {
    const guest = await createUser();
    expect((await (await signIn(guest.email)).get('/api/v1/me/payments')).body).toEqual({ payments: [] });
  });
});

describe('Receipts', () => {
  it('gives the Guest a GST receipt with every line, how it was paid and the refunds', async () => {
    const { guest, booking } = await bookedTrip();
    await createPaymentRecord(booking, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 5_000,
          reason: 'Goodwill',
          fundedBy: 'PLATFORM',
          status: 'SUCCEEDED',
          createdAt: new Date(),
        },
        {
          amountCents: 1_000,
          reason: 'Retry',
          fundedBy: 'PLATFORM',
          status: 'FAILED',
          createdAt: new Date(),
        },
      ],
    });
    const receipt = await (await signIn(guest.email)).get(`/api/v1/bookings/${booking.ref}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt).toMatchObject({
      ref: booking.ref,
      paidAt: booking.statusHistory[1]!.at.toISOString(),
      supplier: { name: 'Rento Vroom', email: 'rentovroom@gmail.com' },
      customer: { name: 'Kiri Tester', email: 'kiri@example.co.nz' },
      vehicleTitle: '2021 Toyota Corolla',
      days: 3,
      lines: [
        { label: '3 days × $89', amountCents: 26_700, gstCents: 3_483 },
        { label: 'Service fee', amountCents: 2_670, gstCents: 348 },
        { label: 'Basic protection', amountCents: 4_500, gstCents: 587 },
      ],
      totalCents: 33_870,
      gstCents: 4_418,
      gstRatePct: 15,
      paidWith: 'Visa ending 4242',
      refundedCents: 5_000,
      netPaidCents: 28_870,
    });
    expect(receipt.body.receipt.refunds).toHaveLength(2);
    // No GST number until the business has one.
    expect(receipt.body.receipt.supplier).not.toHaveProperty('gstNumber');
  });

  it('shows the GST number once it is set in Platform settings', async () => {
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { business: { gstNumber: '123-456-789' } },
    });
    const { guest, booking } = await bookedTrip();
    await createPaymentRecord(booking);
    const receipt = await (await signIn(guest.email)).get(`/api/v1/bookings/${booking.ref}/receipt`);
    expect(receipt.body.receipt.supplier.gstNumber).toBe('123-456-789');
  });

  it('lists the charges after the trip that were paid, with their GST, on the page and in the PDF', async () => {
    const { guest, booking } = await bookedTrip();
    await createPaymentRecord(booking);
    const [paid, waiting] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          extraCharges: [
            {
              _id: paid,
              type: 'EXTRA_KM',
              description: '100 km over',
              amountCents: 3500,
              status: 'SUCCEEDED',
            },
            { _id: waiting, type: 'CLEANING', description: 'Cleaning', amountCents: 8000, status: 'PENDING' },
          ],
        },
      },
    );
    await createPaymentRecord(booking, {
      type: 'EXTRA_CHARGE',
      extraChargeId: paid,
      amountCents: 3500,
      method: 'Mastercard ending 4444',
    });
    const agent = await signIn(guest.email);

    const receipt = (await agent.get(`/api/v1/bookings/${booking.ref}/receipt`)).body.receipt;
    expect(receipt.extraCharges).toEqual([
      expect.objectContaining({
        description: '100 km over',
        amountCents: 3500,
        gstCents: 457,
        paidWith: 'Mastercard ending 4444',
      }),
    ]);
    const pdf = await agent.get(`/api/v1/bookings/${booking.ref}/receipt.pdf`).buffer(true);
    expect(pdf.status).toBe(200);
    // Payment history offers that receipt for the charge too.
    const history = (await agent.get('/api/v1/me/payments')).body.payments as { type: string }[];
    expect(history.find((payment) => payment.type === 'EXTRA_CHARGE')).toMatchObject({ hasReceipt: true });
  });

  it('downloads as a PDF, which handles macrons in names', async () => {
    const { guest, booking } = await bookedTrip();
    await UserModel.updateOne({ _id: guest._id }, { $set: { firstName: 'Tūī', lastName: 'Ngātahi' } });
    await createPaymentRecord(booking);
    const pdf = await (
      await signIn(guest.email)
    )
      .get(`/api/v1/bookings/${booking.ref}/receipt.pdf`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(
      `attachment; filename="rento-vroom-receipt-${booking.ref}.pdf"`,
    );
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(2_000);
  });

  it('is the Guest’s alone, and only once the booking is paid', async () => {
    const { host, guest, booking } = await bookedTrip();
    const guestAgent = await signIn(guest.email);
    const unpaid = await guestAgent.get(`/api/v1/bookings/${booking.ref}/receipt`);
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe('NO_RECEIPT');

    await createPaymentRecord(booking, { status: 'AUTHORISED' });
    expect((await guestAgent.get(`/api/v1/bookings/${booking.ref}/receipt`)).status).toBe(409);

    await createPaymentRecord(booking);
    expect((await guestAgent.get(`/api/v1/bookings/${booking.ref}/receipt`)).status).toBe(200);
    const hostView = await (await signIn(host.email)).get(`/api/v1/bookings/${booking.ref}/receipt`);
    expect(hostView.status).toBe(403);
    await createUser({ email: 'mere@example.co.nz' });
    const stranger = await signIn('mere@example.co.nz');
    expect((await stranger.get(`/api/v1/bookings/${booking.ref}/receipt`)).status).toBe(404);
  });
});

describe('Personal details', () => {
  it('shows the date of birth from the licence details, and corrects the name, in the audit log', async () => {
    const guest = await createUser();
    await UserModel.updateOne({ _id: guest._id }, { $set: { dob: fromNzWallClock(1990, 4, 21) } });
    const agent = await signIn(guest.email);
    expect((await agent.get('/api/v1/me')).body.user).toMatchObject({
      firstName: 'Kiri',
      lastName: 'Tester',
      dateOfBirth: '1990-04-21',
      nameLocked: false,
    });

    const changed = await agent.patch('/api/v1/me').send({ firstName: '  Kiri Aroha ', lastName: 'Ngātahi' });
    expect(changed.status).toBe(200);
    expect(changed.body.user).toMatchObject({ firstName: 'Kiri Aroha', lastName: 'Ngātahi' });
    expect(await UserModel.findById(guest._id).lean()).toMatchObject({
      firstName: 'Kiri Aroha',
      lastName: 'Ngātahi',
    });
    const audit = await AuditLogModel.findOne({ action: 'name.changed' }).lean();
    expect(audit).toMatchObject({
      entity: 'user',
      entityId: guest.id,
      before: { firstName: 'Kiri', lastName: 'Tester' },
      after: { firstName: 'Kiri Aroha', lastName: 'Ngātahi' },
    });
    expect(String(audit?.actorId)).toBe(guest.id);

    // The same name again changes nothing, so nothing more is logged.
    expect((await agent.patch('/api/v1/me').send({ firstName: 'Kiri Aroha' })).status).toBe(200);
    expect(await AuditLogModel.countDocuments({ action: 'name.changed' })).toBe(1);
  });

  it('changes one part of the name, and refuses one that is empty or too long', async () => {
    const guest = await createUser();
    const agent = await signIn(guest.email);
    expect((await agent.get('/api/v1/me')).body.user).not.toHaveProperty('dateOfBirth');

    const last = await agent.patch('/api/v1/me').send({ lastName: 'Parata' });
    expect(last.body.user).toMatchObject({ firstName: 'Kiri', lastName: 'Parata' });

    const blank = await agent.patch('/api/v1/me').send({ firstName: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.fields).toHaveProperty('firstName');
    const long = await agent.patch('/api/v1/me').send({ lastName: 'x'.repeat(51) });
    expect(long.status).toBe(400);
    expect(long.body.error.fields).toHaveProperty('lastName');
    expect((await agent.patch('/api/v1/me').send({})).status).toBe(400);
    expect(await UserModel.findById(guest._id).lean()).toMatchObject({
      firstName: 'Kiri',
      lastName: 'Parata',
    });
  });

  it('fixes the name to the ID once the identity check has passed or is being checked', async () => {
    const locked = [
      { status: 'APPROVED' },
      { status: 'PENDING' },
      { status: 'NONE', sessionStatus: 'processing' },
    ] as const;
    for (const [index, identity] of locked.entries()) {
      const guest = await createUser({ email: `kiri${index}@example.co.nz` });
      await UserModel.updateOne({ _id: guest._id }, { $set: { identityVerification: identity } });
      const agent = await signIn(guest.email);
      expect((await agent.get('/api/v1/me')).body.user.nameLocked).toBe(true);

      const refused = await agent.patch('/api/v1/me').send({ firstName: 'Mere' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('NAME_LOCKED');
      expect((await UserModel.findById(guest._id).lean())?.firstName).toBe('Kiri');
    }

    // A check that didn't pass leaves the name to correct before trying again.
    const rejected = await createUser({ email: 'mere@example.co.nz' });
    await UserModel.updateOne(
      { _id: rejected._id },
      { $set: { identityVerification: { status: 'REJECTED' } } },
    );
    const agent = await signIn(rejected.email);
    expect((await agent.patch('/api/v1/me').send({ firstName: 'Mere' })).body.user.firstName).toBe('Mere');
    expect(await AuditLogModel.countDocuments({ action: 'name.changed' })).toBe(1);
  });

  it('needs an account', async () => {
    expect((await browserAgent().patch('/api/v1/me').send({ firstName: 'Mere' })).status).toBe(401);
  });
});

describe('Privacy requests and closing the account', () => {
  it('opens a PRIVACY ticket, emails its reference, and returns the open one when asked again', async () => {
    const guest = await createUser();
    const agent = await signIn(guest.email);
    const first = await agent.post('/api/v1/me/privacy-requests').send({ type: 'ACCESS' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ref: expect.stringMatching(/^ST-[A-Z0-9]{6}$/), alreadyOpen: false });

    const ticket = await SupportTicketModel.findOne({ ref: first.body.ref }).lean();
    expect(ticket).toMatchObject({
      userId: guest._id,
      email: 'kiri@example.co.nz',
      name: 'Kiri Tester',
      category: 'PRIVACY',
      subject: 'Privacy: a copy of my personal information',
    });
    expect(
      await JobModel.exists({ type: 'email.send', 'payload.template': 'supportTicketReceived' }),
    ).toBeTruthy();
    expect(await AuditLogModel.exists({ action: 'privacy.requested', entityId: guest.id })).toBeTruthy();

    const again = await agent.post('/api/v1/me/privacy-requests').send({ type: 'ACCESS' });
    expect(again.body).toEqual({ ref: first.body.ref, alreadyOpen: true });
    expect(await SupportTicketModel.countDocuments()).toBe(1);
  });

  it('needs to know what to correct', async () => {
    const guest = await createUser();
    const agent = await signIn(guest.email);
    const vague = await agent.post('/api/v1/me/privacy-requests').send({ type: 'CORRECTION' });
    expect(vague.status).toBe(400);
    expect(vague.body.error.fields).toHaveProperty('message');
    const clear = await agent
      .post('/api/v1/me/privacy-requests')
      .send({ type: 'CORRECTION', message: 'My last name is spelt Ngātahi.' });
    expect(clear.status).toBe(201);
    const ticket = await SupportTicketModel.findOne({ ref: clear.body.ref }).lean();
    expect(ticket?.messages[0]?.body).toBe('My last name is spelt Ngātahi.');
  });

  it('can close an account with nothing under way', async () => {
    const guest = await createUser();
    const agent = await signIn(guest.email);
    expect((await agent.get('/api/v1/me/account-closure')).body).toEqual({ allowed: true, blockers: [] });
    const asked = await agent.post('/api/v1/me/privacy-requests').send({ type: 'CLOSE_ACCOUNT' });
    expect(asked.status).toBe(201);
    const ticket = await SupportTicketModel.findOne({ ref: asked.body.ref }).lean();
    expect(ticket?.subject).toBe('Privacy: close my account');
  });

  it('lists what stops an account closing, and refuses until it is sorted', async () => {
    const { host, guest, booking } = await bookedTrip();
    await IncidentModel.create({
      caseRef: 'IN-ABC234',
      bookingId: booking._id,
      reporterId: host._id,
      type: 'DAMAGE',
      description: 'A scratch on the rear door',
    });
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21_360,
      scheduledFor: new Date(),
    });

    const guestAgent = await signIn(guest.email);
    const closure = await guestAgent.get('/api/v1/me/account-closure');
    expect(closure.body.allowed).toBe(false);
    expect(closure.body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual([
      'UPCOMING_TRIP',
      'OPEN_INCIDENT',
    ]);
    const refused = await guestAgent.post('/api/v1/me/privacy-requests').send({ type: 'CLOSE_ACCOUNT' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'CLOSURE_BLOCKED',
      fields: { blockers: 'UPCOMING_TRIP,OPEN_INCIDENT' },
    });
    expect(await SupportTicketModel.countDocuments()).toBe(0);

    const hostClosure = await (await signIn(host.email)).get('/api/v1/me/account-closure');
    expect(hostClosure.body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual([
      'HOSTED_BOOKING',
      'OPEN_INCIDENT',
      'PAYOUT_DUE',
    ]);
  });

  it('counts an unpaid extra charge from a finished trip', async () => {
    const { guest, booking } = await bookedTrip({ status: 'COMPLETED' });
    booking.extraCharges.push({
      type: 'EXTRA_KM',
      description: '40 km over',
      amountCents: 1_400,
      status: 'FAILED',
    });
    await booking.save();
    const closure = await (await signIn(guest.email)).get('/api/v1/me/account-closure');
    expect(closure.body.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['UNPAID_CHARGE']);
  });
});

describe('Help centre', () => {
  beforeEach(async () => {
    await HelpArticleModel.create([
      {
        slug: 'how-booking-works',
        title: 'How booking works',
        category: 'Booking',
        audience: 'GUEST',
        published: true,
        order: 2,
        body: '## Start here\n\nSearch by **place** and dates, then [book](/cars) in a few steps.\n\n- More',
      },
      {
        slug: 'getting-paid',
        title: 'Getting paid',
        category: 'Payouts',
        audience: 'HOST',
        published: true,
        order: 1,
        body: 'Payouts go to your bank.',
      },
      {
        slug: 'contacting-us',
        title: 'Contacting us',
        category: 'Support',
        audience: 'ALL',
        published: true,
        order: 3,
        body: 'Email us any time.',
      },
      {
        slug: 'draft',
        title: 'Not ready',
        category: 'Support',
        audience: 'ALL',
        published: false,
        order: 0,
        body: 'Draft.',
      },
    ]);
  });

  it('lists published articles in order, for an audience with the ones for everyone', async () => {
    const all = await browserAgent().get('/api/v1/help/articles');
    expect(all.status).toBe(200);
    expect(all.headers['cache-control']).toBe('public, max-age=60');
    expect(all.body.articles.map((article: { slug: string }) => article.slug)).toEqual([
      'getting-paid',
      'how-booking-works',
      'contacting-us',
    ]);
    expect(all.body.articles[1]).toEqual({
      slug: 'how-booking-works',
      title: 'How booking works',
      category: 'Booking',
      audience: 'GUEST',
      summary: 'Search by place and dates, then book in a few steps.',
    });

    const guests = await browserAgent().get('/api/v1/help/articles?audience=GUEST');
    expect(guests.body.articles.map((article: { slug: string }) => article.slug)).toEqual([
      'how-booking-works',
      'contacting-us',
    ]);
    // An audience it doesn't know shows everything rather than failing.
    const unknown = await browserAgent().get('/api/v1/help/articles?audience=PILOT');
    expect(unknown.body.articles).toHaveLength(3);
  });

  it('opens one published article by its slug', async () => {
    const article = await browserAgent().get('/api/v1/help/articles/How-Booking-Works');
    expect(article.status).toBe(200);
    expect(article.body.article).toMatchObject({
      slug: 'how-booking-works',
      title: 'How booking works',
      body: expect.stringContaining('## Start here'),
    });
    expect((await browserAgent().get('/api/v1/help/articles/draft')).status).toBe(404);
    expect((await browserAgent().get('/api/v1/help/articles/nope')).status).toBe(404);
  });

  it('summarises an article as plain text, cut at a word', () => {
    expect(articleSummary('# Title\n\nFirst `paragraph` with _emphasis_.\n\nSecond.')).toBe(
      'First paragraph with emphasis.',
    );
    const long = `${'word '.repeat(60)}end`;
    const summary = articleSummary(long);
    expect(summary.length).toBeLessThanOrEqual(181);
    expect(summary.endsWith('word…')).toBe(true);
  });
});

describe('My support requests', () => {
  async function ticketFor(userId: unknown, overrides: Record<string, unknown> = {}) {
    return SupportTicketModel.create({
      ref: 'ST-ABC234',
      userId,
      email: 'kiri@example.co.nz',
      subject: 'Where do I collect the car?',
      category: 'BOOKING',
      messages: [
        { authorId: userId, body: 'Is it at the airport?', createdAt: new Date(Date.now() - 60_000) },
      ],
      ...overrides,
    });
  }

  it('lists only the user’s own tickets, with the booking they are about', async () => {
    const { guest, booking } = await bookedTrip();
    await ticketFor(guest._id, { bookingId: booking._id });
    const other = await createUser({ email: 'mere@example.co.nz' });
    await ticketFor(other._id, { ref: 'ST-XYZ789' });

    const list = await (await signIn(guest.email)).get('/api/v1/support/tickets');
    expect(list.status).toBe(200);
    expect(list.body.tickets).toEqual([
      expect.objectContaining({
        ref: 'ST-ABC234',
        subject: 'Where do I collect the car?',
        category: 'BOOKING',
        status: 'OPEN',
        bookingRef: booking.ref,
      }),
    ]);
  });

  it('shows the conversation without staff notes, and a reply goes back to support', async () => {
    const guest = await createUser();
    const staff = await createStaff('aroha@example.co.nz', 'SUPPORT');
    const ticket = await ticketFor(guest._id, { status: 'RESOLVED' });
    ticket.messages.push(
      {
        authorId: staff._id,
        body: 'Check their ID first.',
        internal: true,
        attachments: [],
        createdAt: new Date(),
      },
      {
        authorId: staff._id,
        body: 'It’s at the Host’s home.',
        internal: false,
        attachments: [],
        createdAt: new Date(),
      },
    );
    await ticket.save();
    const agent = await signIn(guest.email);

    const opened = await agent.get('/api/v1/support/tickets/st-abc234');
    expect(opened.status).toBe(200);
    expect(
      opened.body.ticket.messages.map((message: { from: string; body: string }) => [
        message.from,
        message.body,
      ]),
    ).toEqual([
      ['YOU', 'Is it at the airport?'],
      ['SUPPORT', 'It’s at the Host’s home.'],
    ]);

    const replied = await agent
      .post('/api/v1/support/tickets/ST-ABC234/messages')
      .send({ body: 'Thanks, found it.' });
    expect(replied.status).toBe(200);
    expect(replied.body.ticket.status).toBe('OPEN');
    expect(replied.body.ticket.messages.at(-1)).toMatchObject({ from: 'YOU', body: 'Thanks, found it.' });
    expect((await agent.post('/api/v1/support/tickets/ST-ABC234/messages').send({ body: ' ' })).status).toBe(
      400,
    );
  });

  it('keeps other people’s tickets hidden', async () => {
    const owner = await createUser({ email: 'mere@example.co.nz' });
    await ticketFor(owner._id);
    const guest = await createUser();
    const agent = await signIn(guest.email);
    expect((await agent.get('/api/v1/support/tickets/ST-ABC234')).status).toBe(404);
    expect(
      (await agent.post('/api/v1/support/tickets/ST-ABC234/messages').send({ body: 'Hello there' })).status,
    ).toBe(404);
    expect((await agent.get('/api/v1/support/tickets/nope')).status).toBe(404);
  });
});
