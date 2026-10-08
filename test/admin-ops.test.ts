import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripe } from '../src/integrations/stripe.js';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { CmsBlockModel } from '../src/modules/cms/cms-block.model.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { ReportModel } from '../src/modules/moderation/report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { runPayout } from '../src/modules/payouts/payouts.service.js';
import { checkBookingVelocity, checkPaymentRisk } from '../src/modules/risk/risk-signals.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel, liveVehicleFilter } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const client = stripe();

beforeEach(() => {
  // The card and Radar check after a payment reads the charge; most tests don't need one.
  vi.spyOn(client.paymentIntents, 'retrieve').mockResolvedValue({
    id: 'pi_1',
    latest_charge: 'ch_1',
  } as unknown as Stripe.Response<Stripe.PaymentIntent>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function trip(overrides: Parameters<typeof createBookingRecord>[1] = {}) {
  const host = await createHost();
  const guest = await createUser();
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    overrides,
  );
  return { host, guest, vehicle, booking };
}

async function tripPayout(
  booking: { _id: unknown; hostId: unknown },
  overrides: Record<string, unknown> = {},
) {
  return PayoutModel.create({
    hostId: booking.hostId,
    bookingId: booking._id,
    type: 'TRIP',
    amountCents: 21360,
    status: 'SCHEDULED',
    scheduledFor: new Date(Date.now() - 60_000),
    ...overrides,
  });
}

describe('user management', () => {
  it('suspends a Host: signed out, listings hidden, payouts held, upcoming bookings listed; lifting it undoes that', async () => {
    const { host, vehicle, booking } = await trip();
    await UserModel.updateOne(
      { _id: host._id },
      { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_1' } },
    );
    const signIn = await browserAgent()
      .post('/api/v1/auth/login')
      .send({ email: 'hana@example.co.nz', password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(await SessionModel.countDocuments({ userId: host._id })).toBe(1);
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');

    const found = await agent.get('/api/v1/admin/users').query({ q: 'hana@' });
    expect(found.body.users.map((user: { email: string }) => user.email)).toEqual(['hana@example.co.nz']);

    const suspended = await agent
      .post(`/api/v1/admin/users/${host.id}/suspend`)
      .send({ reason: 'Listing a car they do not own' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.user.status).toBe('SUSPENDED');
    expect(suspended.body.user.upcomingBookings.map((row: { ref: string }) => row.ref)).toEqual([
      booking.ref,
    ]);
    expect(await SessionModel.countDocuments({ userId: host._id })).toBe(0);
    expect(await VehicleModel.countDocuments({ _id: vehicle._id, ...liveVehicleFilter() })).toBe(0);

    const payout = await tripPayout(booking);
    expect(await runPayout(payout.id)).toBe('held');
    expect((await PayoutModel.findById(payout._id))!.holdReason).toBe('SUSPENDED');

    const lifted = await agent.post(`/api/v1/admin/users/${host.id}/unsuspend`);
    expect(lifted.body.user.status).toBe('ACTIVE');
    expect(await VehicleModel.countDocuments({ _id: vehicle._id, ...liveVehicleFilter() })).toBe(1);
    expect((await PayoutModel.findById(payout._id))!.status).toBe('SCHEDULED');
    expect(
      await AuditLogModel.countDocuments({
        action: mongoose.trusted({ $in: ['user.suspended', 'user.unsuspended'] }),
      }),
    ).toBe(2);
  });

  it('keeps support away from staff accounts and from closing accounts', async () => {
    const guest = await createUser();
    const other = await createStaff('mere@example.co.nz', 'SUPPORT');
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');

    const staff = await agent.post(`/api/v1/admin/users/${other.id}/suspend`).send({ reason: 'Testing it' });
    expect(staff.status).toBe(403);
    const close = await agent.post(`/api/v1/admin/users/${guest.id}/close`);
    expect(close.status).toBe(403);
    const permissions = await agent
      .post(`/api/v1/admin/staff/${other.id}/permissions`)
      .send({ refunds: true });
    expect(permissions.status).toBe(403);
  });

  it('closes an account only when nothing is under way, and anonymises it', async () => {
    const { guest, booking } = await trip();
    await createStaff();
    const agent = await staffAgent();

    const blocked = await agent.post(`/api/v1/admin/users/${guest.id}/close`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CLOSURE_BLOCKED');

    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'COMPLETED' } });
    const closed = await agent.post(`/api/v1/admin/users/${guest.id}/close`);
    expect(closed.status).toBe(200);
    const user = await UserModel.findById(guest._id).lean();
    expect(user!.closedAt).toBeDefined();
    expect(user!.email).toMatch(/^closed-.+@closed\.rentovroom\.invalid$/);
    expect(user!.firstName).toBe('Former');
    expect(await BookingModel.countDocuments({ guestId: guest._id })).toBe(1);
  });

  it('lets the admin give a support member the refunds permission', async () => {
    const support = await createStaff('sam@example.co.nz', 'SUPPORT');
    await createStaff();
    const agent = await staffAgent();
    const given = await agent.post(`/api/v1/admin/staff/${support.id}/permissions`).send({ refunds: true });
    expect(given.body.user.permissions).toEqual(['REFUNDS']);
  });

  it('waives a Host’s cancellation fees with a reason', async () => {
    const host = await createHost();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 5000 } });
    await createStaff();
    const agent = await staffAgent();
    const waived = await agent
      .post(`/api/v1/admin/users/${host.id}/waive-host-fee`)
      .send({ amountCents: 2000, reason: 'Cancelled for a medical emergency' });
    expect(waived.body.user.host.feesOwedCents).toBe(3000);
  });
});

describe('bookings', () => {
  it('finds a booking and shows its whole record', async () => {
    const { booking } = await trip();
    await createPaymentRecord(booking);
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');

    const list = await agent.get('/api/v1/admin/bookings').query({ q: booking.ref.toLowerCase() });
    expect(list.body.bookings).toHaveLength(1);
    const detail = await agent.get(`/api/v1/admin/bookings/${booking.ref}`);
    expect(detail.status).toBe(200);
    expect(detail.body.guest.email).toBe('kiri@example.co.nz');
    expect(detail.body.payments[0].status).toBe('SUCCEEDED');
    expect(detail.body.refundableCents).toBe(33870);
  });

  it('marks a trip started (releasing its payout) and then completed, with the same side effects', async () => {
    const { booking } = await trip({ startAt: new Date(Date.now() - 60 * 60 * 1000) });
    const payout = await tripPayout(booking, { status: 'HELD', holdReason: 'TRIP_NOT_STARTED' });
    await createStaff();
    const agent = await staffAgent();

    const wrong = await agent
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'COMPLETED', reason: 'Guest returned it' });
    expect(wrong.status).toBe(409);

    const started = await agent
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'ACTIVE', reason: 'Checked in on paper' });
    expect(started.status).toBe(200);
    expect(started.body.booking.status).toBe('ACTIVE');
    expect(started.body.statusHistory.at(-1).reason).toBe('Changed by support: Checked in on paper');
    expect((await PayoutModel.findById(payout._id))!.status).toBe('SCHEDULED');

    const completed = await agent
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'COMPLETED', reason: 'Car returned, app was down' });
    expect(completed.body.booking.status).toBe('COMPLETED');
    expect(await JobModel.countDocuments({ type: 'trip.extraCharges', refId: booking.id })).toBe(1);
    expect(await JobModel.countDocuments({ type: 'trip.reviewRequest', refId: booking.id })).toBeGreaterThan(
      0,
    );
  });

  it('refunds with the refunds permission, and a Host-funded refund after payout is owed by the Host', async () => {
    const { host, booking } = await trip({ status: 'COMPLETED' });
    const payment = await createPaymentRecord(booking);
    await tripPayout(booking, { status: 'PAID', paidAt: new Date() });
    vi.spyOn(client.refunds, 'create').mockResolvedValue({
      id: 're_1',
      status: 'succeeded',
    } as Stripe.Response<Stripe.Refund>);
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const support = await staffAgent('sam@example.co.nz');
    const refused = await support
      .post(`/api/v1/admin/bookings/${booking.id}/refunds`)
      .send({ amountCents: 5000, reason: 'Car was not cleaned', fundedBy: 'HOST' });
    expect(refused.status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    const refunded = await admin
      .post(`/api/v1/admin/bookings/${booking.id}/refunds`)
      .send({ amountCents: 5000, reason: 'Car was not cleaned', fundedBy: 'HOST' });
    expect(refunded.status).toBe(200);
    expect(refunded.body.refundableCents).toBe(33870 - 5000);
    expect((await PaymentModel.findById(payment._id))!.status).toBe('PARTIALLY_REFUNDED');
    expect((await UserModel.findById(host._id))!.hostProfile!.feesOwedCents).toBe(5000);
    expect(await NotificationModel.countDocuments({ type: 'REFUND_ISSUED', channel: 'IN_APP' })).toBe(1);
  });
});

describe('payouts and cars', () => {
  it('holds a payout until staff release it', async () => {
    const { host, booking } = await trip();
    await UserModel.updateOne(
      { _id: host._id },
      { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_1' } },
    );
    const payout = await tripPayout(booking);
    await createStaff();
    const agent = await staffAgent();

    const held = await agent
      .post(`/api/v1/admin/payouts/${payout.id}/hold`)
      .send({ reason: 'Checking the damage claim' });
    expect(held.body.payout).toMatchObject({ status: 'HELD', holdReason: 'MANUAL' });
    expect(await runPayout(payout.id)).toBe('held');
    expect((await PayoutModel.findById(payout._id))!.holdReason).toBe('MANUAL');

    const list = await agent.get('/api/v1/admin/payouts').query({ status: 'HELD' });
    expect(list.body.payouts).toHaveLength(1);
    const released = await agent.post(`/api/v1/admin/payouts/${payout.id}/release`);
    expect(released.body.payout.status).toBe('SCHEDULED');
  });

  it('suspends a car and puts it back as it was', async () => {
    const { vehicle, booking } = await trip();
    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { status: 'INACTIVE' } });
    await createStaff();
    const agent = await staffAgent();
    const suspended = await agent
      .post(`/api/v1/admin/vehicles/${vehicle.id}/suspend`)
      .send({ reason: 'Rego plate does not match' });
    expect(suspended.body.vehicle.status).toBe('SUSPENDED');
    expect(suspended.body.upcomingBookings[0].ref).toBe(booking.ref);
    const lifted = await agent.post(`/api/v1/admin/vehicles/${vehicle.id}/unsuspend`);
    expect(lifted.body.vehicle.status).toBe('INACTIVE');
  });
});

describe('support inbox and moderation', () => {
  it('replies to a ticket by email and in the account, and keeps internal notes from the sender', async () => {
    const guest = await createUser();
    await SupportTicketModel.create({
      ref: 'ST-ABC123',
      userId: guest._id,
      name: 'Kiri Tester',
      email: 'kiri@example.co.nz',
      subject: 'Where is my refund?',
      category: 'PAYMENT',
      messages: [{ authorId: guest._id, body: 'I cancelled last week.', createdAt: new Date() }],
    });
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');

    const inbox = await agent.get('/api/v1/admin/support/tickets');
    expect(inbox.body.tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(['ST-ABC123']);
    await agent
      .post('/api/v1/admin/support/tickets/ST-ABC123/messages')
      .send({ body: 'Refund was approved by the team lead.', internal: true });
    const replied = await agent
      .post('/api/v1/admin/support/tickets/ST-ABC123/messages')
      .send({ body: 'Your refund is on its way.' });
    expect(replied.body.ticket.status).toBe('PENDING');
    expect(replied.body.ticket.assignedTo).toBe('Aroha Tester');
    expect(replied.body.ticket.thread).toHaveLength(3);
    expect(await NotificationModel.countDocuments({ type: 'SUPPORT_REPLY', channel: 'EMAIL' })).toBe(1);

    const user = browserAgent();
    await user.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });
    const own = await user.get('/api/v1/support/tickets/ST-ABC123');
    expect(own.body.ticket.messages.map((message: { body: string }) => message.body)).toEqual([
      'I cancelled last week.',
      'Your refund is on its way.',
    ]);
  });

  it('shows a reported message with its booking, and records the decision', async () => {
    const { guest, host, booking } = await trip();
    const thread = await ThreadModel.create({ bookingId: booking._id });
    const message = await MessageModel.create({
      threadId: thread._id,
      senderId: host._id,
      body: 'Pay me in cash',
    });
    const report = await ReportModel.create({
      reporterId: guest._id,
      targetType: 'MESSAGE',
      targetId: message._id,
      subjectUserId: host._id,
      reason: 'SCAM',
    });
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');

    const queue = await agent.get('/api/v1/admin/moderation/reports');
    expect(queue.body.reports[0]).toMatchObject({
      preview: 'Pay me in cash',
      bookingRef: booking.ref,
      subject: { name: 'Hana Tester' },
    });
    const resolved = await agent
      .post(`/api/v1/admin/moderation/reports/${report.id}/resolve`)
      .send({ status: 'ACTIONED', resolution: 'Warned the Host about payments outside the platform' });
    expect(resolved.body.report.status).toBe('ACTIONED');
  });
});

describe('content, reports, audit log and jobs', () => {
  it('lets only the admin manage FAQs, featured cars and legal pages', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    await CmsBlockModel.create({
      key: 'legal.terms',
      version: '2026-09-28',
      content: { title: 'Terms', markdown: 'Placeholder terms for testing purposes.' },
    });
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const support = await staffAgent('sam@example.co.nz');
    expect((await support.get('/api/v1/admin/content/faqs')).status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    const created = await admin.post('/api/v1/admin/content/faqs').send({
      question: 'Can I take the car on the ferry?',
      answer: 'Yes, if the Host allows it.',
      category: 'Trips',
      audience: 'GUEST',
    });
    expect(created.status).toBe(201);
    const faqs = await browserAgent().get('/api/v1/faqs');
    expect(faqs.body.faqs.map((faq: { question: string }) => faq.question)).toContain(
      'Can I take the car on the ferry?',
    );

    const featured = await admin
      .put('/api/v1/admin/content/featured-vehicles')
      .send({ vehicleIds: [vehicle.id] });
    expect(featured.body.vehicles[0]).toMatchObject({ id: vehicle.id, live: true });

    const legal = await admin
      .put('/api/v1/admin/content/legal/legal.terms')
      .send({ title: 'Terms of use', markdown: 'These are the corrected terms of use for testing.' });
    expect(legal.body.page).toMatchObject({ title: 'Terms of use', version: '2026-09-28' });
  });

  it('reports the period’s figures and exports them as CSV', async () => {
    const { booking } = await trip({ startAt: new Date(Date.now() + DAY_MS) });
    await createStaff();
    const agent = await staffAgent();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());
    const later = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(
      new Date(Date.now() + 5 * DAY_MS),
    );

    const summary = await agent.get('/api/v1/admin/reports/summary').query({ from: today, to: later });
    expect(summary.body.report.money.grossBookingsCents).toBe(33870);
    expect(summary.body.report.money.gstCollectedCents).toBe(4418);

    const csv = await agent
      .get('/api/v1/admin/reports/export')
      .query({ type: 'bookings', from: today, to: later });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain(booking.ref);
    expect(csv.text).toContain('338.70');

    const dashboard = await agent.get('/api/v1/admin/dashboard');
    expect(dashboard.body.figures.upcomingBookings).toBe(1);
    expect(dashboard.body.queues.failedJobs).toBe(0);
  });

  it('lists the audit log and runs a failed job again', async () => {
    const job = await JobModel.create({
      type: 'email.send',
      payload: {},
      runAt: new Date(),
      status: 'FAILED',
      attempts: 5,
      lastError: 'Resend is down',
    });
    await createStaff();
    const agent = await staffAgent();
    const failed = await agent.get('/api/v1/admin/jobs');
    expect(failed.body.jobs[0]).toMatchObject({ id: job.id, lastError: 'Resend is down' });
    const retried = await agent.post(`/api/v1/admin/jobs/${job.id}/retry`);
    expect(retried.body.job.status).toBe('QUEUED');
    const audit = await agent.get('/api/v1/admin/audit').query({ action: 'job.retried' });
    expect(audit.body.entries[0]).toMatchObject({
      entity: 'job',
      entityId: job.id,
      actor: { name: 'Aroha Tester' },
    });
  });
});

describe('risk flags', () => {
  it('flags many bookings in a day, a foreign card and a Radar warning, and staff clear them', async () => {
    const { guest, booking } = await trip();
    for (let index = 0; index < 5; index += 1) {
      await createBookingRecord({ guestId: guest._id, hostId: booking.hostId, vehicleId: booking.vehicleId });
    }
    await checkBookingVelocity(guest._id);
    const payment = await createPaymentRecord(booking);
    vi.spyOn(client.paymentIntents, 'retrieve').mockResolvedValue({
      id: payment.stripePaymentIntentId,
      latest_charge: {
        id: 'ch_1',
        payment_method_details: { card: { country: 'US' } },
        outcome: { risk_level: 'elevated', type: 'authorized', reason: null },
      },
    } as unknown as Stripe.Response<Stripe.PaymentIntent>);
    await checkPaymentRisk(payment.id);

    const flagged = await UserModel.findById(guest._id).lean();
    expect(flagged!.riskFlags.map((flag) => flag.code).sort()).toEqual([
      'BOOKING_VELOCITY',
      'CARD_COUNTRY',
      'RADAR_WARNING',
    ]);

    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');
    const queue = await agent.get('/api/v1/admin/risk');
    expect(queue.body.users[0].flags).toHaveLength(3);
    const flagId = queue.body.users[0].flags[0].id;
    const cleared = await agent.post(`/api/v1/admin/users/${guest.id}/risk-flags/${flagId}/clear`);
    expect(cleared.body.user.openRiskFlags).toBe(2);
  });
});
