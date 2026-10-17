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

  it('holds a suspended Host’s scheduled payouts at once, except one being sent, and lifting it releases them', async () => {
    const { host, booking } = await trip();
    await UserModel.updateOne(
      { _id: host._id },
      { $set: { 'hostProfile.payoutsEnabled': true, 'hostProfile.stripeAccountId': 'acct_1' } },
    );
    const waiting = await tripPayout(booking, { scheduledFor: new Date(Date.now() + DAY_MS) });
    const sending = await tripPayout(booking, { type: 'EXTRA_CHARGE', deductionsReservedAt: new Date() });
    await createStaff();
    const agent = await staffAgent();

    await agent.post(`/api/v1/admin/users/${host.id}/suspend`).send({ reason: 'Checking their listings' });
    expect(await PayoutModel.findById(waiting._id).lean()).toMatchObject({
      status: 'HELD',
      holdReason: 'SUSPENDED',
    });
    expect((await PayoutModel.findById(sending._id).lean())!.status).toBe('SCHEDULED');
    expect(await AuditLogModel.findOne({ action: 'user.suspended' }).lean()).toMatchObject({
      after: { payoutsHeld: 1 },
    });

    await agent.post(`/api/v1/admin/users/${host.id}/unsuspend`);
    const released = (await PayoutModel.findById(waiting._id).lean())!;
    expect(released.status).toBe('SCHEDULED');
    expect(released.holdReason).toBeUndefined();
  });

  it('corrects a person’s details on a privacy request, in the audit log, and emails a new address to confirm', async () => {
    const guest = await createUser();
    await UserModel.updateOne(
      { _id: guest._id },
      {
        $set: {
          dob: new Date('1990-04-19T12:00:00Z'),
          emailVerifiedAt: new Date(),
          identityVerification: { status: 'APPROVED', verifiedAt: new Date() },
        },
      },
    );
    await createUser({ email: 'taken@example.co.nz', firstName: 'Tama' });
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');
    const path = `/api/v1/admin/users/${guest.id}`;

    const taken = await agent
      .patch(path)
      .send({ email: 'taken@example.co.nz', reason: 'Privacy request ST-ABC123' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');
    expect((await agent.patch(path).send({ reason: 'Nothing to change' })).status).toBe(400);

    const corrected = await agent.patch(path).send({
      lastName: 'Ngātahi',
      dob: '1990-04-21',
      email: 'kiri.n@example.co.nz',
      reason: 'Privacy request ST-ABC123, checked against her passport',
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.user).toMatchObject({
      lastName: 'Ngātahi',
      dob: '1990-04-21',
      email: 'kiri.n@example.co.nz',
      emailVerified: false,
    });
    expect(
      await JobModel.exists({
        type: 'email.send',
        'payload.template': 'verifyEmail',
        'payload.to': 'kiri.n@example.co.nz',
      }),
    ).toBeTruthy();
    expect(
      await JobModel.exists({
        type: 'email.send',
        'payload.template': 'emailChanged',
        'payload.to': 'kiri@example.co.nz',
      }),
    ).toBeTruthy();
    expect(await AuditLogModel.findOne({ action: 'user.corrected' }).lean()).toMatchObject({
      entityId: guest.id,
      before: { lastName: 'Tester', dob: '1990-04-20', email: 'kiri@example.co.nz' },
      after: {
        lastName: 'Ngātahi',
        email: 'kiri.n@example.co.nz',
        identityChecked: true,
        reason: 'Privacy request ST-ABC123, checked against her passport',
      },
    });
  });

  it('downloads a person’s information for a privacy request, without anyone else’s details or staff notes', async () => {
    const { host, guest, booking } = await trip();
    const payment = await createPaymentRecord(booking);
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        $push: {
          refunds: {
            amountCents: 1_000,
            reason: 'Goodwill',
            fundedBy: 'PLATFORM',
            status: 'SUCCEEDED',
            createdAt: new Date(),
          },
        },
      },
    );
    const thread = await ThreadModel.create({
      bookingId: booking._id,
      participantIds: [guest._id, host._id],
    });
    await MessageModel.create({ threadId: thread._id, senderId: guest._id, body: 'See you at 10' });
    await MessageModel.create({
      threadId: thread._id,
      senderId: host._id,
      body: 'My number is 021 555 0101',
    });
    await SupportTicketModel.create({
      ref: 'ST-EXP001',
      userId: guest._id,
      subject: 'Privacy: a copy of my personal information',
      category: 'PRIVACY',
      messages: [
        { authorId: guest._id, body: 'Please send it' },
        { authorId: host._id, body: 'Check her ID first', internal: true },
      ],
    });
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');

    const download = await agent.get(`/api/v1/admin/users/${guest.id}/export`).query({ ticket: 'st-exp001' });
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="rento-vroom-data-/);
    const data = JSON.parse(download.text);
    expect(data.account).toMatchObject({ email: 'kiri@example.co.nz', firstName: 'Kiri' });
    expect(data.bookings).toEqual([expect.objectContaining({ ref: booking.ref, as: 'GUEST' })]);
    expect(data.payments[0]).toMatchObject({
      booking: booking.ref,
      refunds: [expect.objectContaining({ amountCents: 1_000 })],
    });
    expect(data.messagesSent.map((message: { body: string }) => message.body)).toEqual(['See you at 10']);
    expect(data.supportRequests[0].messages.map((message: { body: string }) => message.body)).toEqual([
      'Please send it',
    ]);
    expect(download.text).not.toContain('Hana');
    expect(download.text).not.toContain('021 555 0101');
    expect(await AuditLogModel.findOne({ action: 'user.exported', entityId: guest.id }).lean()).toMatchObject(
      { after: { ticket: 'ST-EXP001' } },
    );
  });

  it('downloads someone’s information only from a privacy request they sent, even for the admin', async () => {
    const { host, guest } = await trip();
    await SupportTicketModel.create([
      // Hana's privacy request, and a booking question from Kiri.
      { ref: 'ST-HANA01', userId: host._id, subject: 'Privacy: my data', category: 'PRIVACY' },
      { ref: 'ST-KIRI01', userId: guest._id, subject: 'Where do I pick up?', category: 'BOOKING' },
      // Resolved, but still the request the download answers.
      {
        ref: 'ST-KIRI02',
        userId: guest._id,
        subject: 'Privacy: a copy of my information',
        category: 'PRIVACY',
        status: 'RESOLVED',
      },
    ]);
    await createStaff();
    const admin = await staffAgent();
    const exportOf = (ticket?: string) =>
      admin.get(`/api/v1/admin/users/${guest.id}/export`).query(ticket ? { ticket } : {});

    expect((await exportOf()).status).toBe(400);
    for (const ticket of ['ST-HANA01', 'ST-KIRI01', 'ST-NONE01']) {
      const refused = await exportOf(ticket);
      expect(refused.status, ticket).toBe(403);
      expect(refused.body.error.code, ticket).toBe('NO_PRIVACY_REQUEST');
    }
    expect(await AuditLogModel.exists({ action: 'user.exported' })).toBeNull();
    expect((await exportOf('ST-KIRI02')).status).toBe(200);
  });

  it('links a request sent signed out to the account with its email, after which its download works', async () => {
    const { guest } = await trip();
    await SupportTicketModel.create([
      // From the Contact form while signed out, with the email on Kiri's account.
      {
        ref: 'ST-OUT001',
        name: 'Kiri',
        email: guest.email,
        subject: 'Privacy: my data',
        category: 'PRIVACY',
      },
      // And one from an address no account has.
      { ref: 'ST-OUT002', name: 'Rua', email: 'rua@example.co.nz', subject: 'Privacy', category: 'PRIVACY' },
    ]);
    await createStaff();
    const admin = await staffAgent();
    const exportOf = () => admin.get(`/api/v1/admin/users/${guest.id}/export`).query({ ticket: 'ST-OUT001' });

    const shown = await admin.get('/api/v1/admin/support/tickets/ST-OUT001');
    expect(shown.body.ticket.accountWithEmail).toEqual({ id: guest.id, name: 'Kiri Tester' });
    const other = await admin.get('/api/v1/admin/support/tickets/ST-OUT002');
    expect(other.body.ticket.accountWithEmail).toBeUndefined();
    // Not their request until it's linked.
    expect((await exportOf()).status).toBe(403);

    const linked = await admin
      .post('/api/v1/admin/support/tickets/ST-OUT001/link-account')
      .send({ note: 'They replied from that address' });
    expect(linked.status).toBe(200);
    expect(linked.body.ticket.from.userId).toBe(guest.id);
    expect(linked.body.ticket.accountWithEmail).toBeUndefined();
    expect(
      await AuditLogModel.findOne({ action: 'ticket.linked', entityId: 'ST-OUT001' }).lean(),
    ).toMatchObject({
      after: { userId: guest.id, note: 'They replied from that address' },
    });
    const again = await admin.post('/api/v1/admin/support/tickets/ST-OUT001/link-account').send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_LINKED');
    const nobody = await admin.post('/api/v1/admin/support/tickets/ST-OUT002/link-account').send({});
    expect(nobody.status).toBe(404);
    expect(nobody.body.error.code).toBe('NO_ACCOUNT');

    expect((await exportOf()).status).toBe(200);
    // It's theirs now: in their account's requests too.
    const theirs = await SupportTicketModel.findOne({ ref: 'ST-OUT001' }).lean();
    expect(theirs?.userId?.equals(guest._id)).toBe(true);
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

    // Finished a week ago: past the damage-report window.
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          status: 'COMPLETED',
          startAt: new Date(Date.now() - 10 * DAY_MS),
          endAt: new Date(Date.now() - 7 * DAY_MS),
        },
      },
    );
    const closed = await agent.post(`/api/v1/admin/users/${guest.id}/close`);
    expect(closed.status).toBe(200);
    const user = await UserModel.findById(guest._id).lean();
    expect(user!.closedAt).toBeDefined();
    expect(user!.email).toMatch(/^closed-.+@closed\.rentovroom\.invalid$/);
    expect(user!.firstName).toBe('Former');
    expect(await BookingModel.countDocuments({ guestId: guest._id })).toBe(1);
  });

  it('removes a closed account’s saved cards and details from Stripe, and closes it even if Stripe fails', async () => {
    const kiri = await createUser();
    const mere = await createUser({ email: 'mere@example.co.nz', firstName: 'Mere' });
    await UserModel.updateOne({ _id: kiri._id }, { $set: { stripeCustomerId: 'cus_kiri' } });
    await UserModel.updateOne({ _id: mere._id }, { $set: { stripeCustomerId: 'cus_mere' } });
    const update = vi
      .spyOn(client.customers, 'update')
      .mockResolvedValueOnce({ id: 'cus_kiri' } as Stripe.Response<Stripe.Customer>)
      .mockRejectedValueOnce(new Error('Stripe is down'));
    vi.spyOn(client.customers, 'listPaymentMethods').mockResolvedValue({
      data: [{ id: 'pm_visa' }, { id: 'pm_mastercard' }],
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.PaymentMethod>>);
    const detach = vi
      .spyOn(client.paymentMethods, 'detach')
      .mockResolvedValue({ id: 'pm_visa' } as Stripe.Response<Stripe.PaymentMethod>);
    await createStaff();
    const agent = await staffAgent();

    expect((await agent.post(`/api/v1/admin/users/${kiri.id}/close`)).status).toBe(200);
    // Updated, not deleted, so the payments kept for the law still resolve.
    expect(update).toHaveBeenCalledWith('cus_kiri', {
      name: 'Former member',
      email: '',
      phone: '',
      description: '',
      address: '',
      shipping: '',
      metadata: '',
    });
    expect(detach.mock.calls.map(([id]) => id)).toEqual(['pm_visa', 'pm_mastercard']);
    expect((await UserModel.findById(kiri._id).lean())!.stripeCustomerId).toBeUndefined();

    // Stripe refusing doesn't keep the account open.
    expect((await agent.post(`/api/v1/admin/users/${mere.id}/close`)).status).toBe(200);
    expect((await UserModel.findById(mere._id).lean())!.closedAt).toBeDefined();
    expect(detach).toHaveBeenCalledTimes(4);
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
    // Owed as a refund, apart from Host cancellation fees (plan §8.1, item 15): the Host's 80 % share of it.
    expect(refunded.body.hostRefund).toEqual({ recoveredFrom: 'NEXT_PAYOUT', owedCents: 4000 });
    const owed = (await UserModel.findById(host._id))!.hostProfile!;
    expect(owed.feesOwedCents).toBe(0);
    expect(owed.refundsOwed).toEqual([
      expect.objectContaining({ bookingId: booking._id, stripeRefundId: 're_1', amountCents: 4000 }),
    ]);
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

  it('lists every car for staff, by words, status and Host', async () => {
    const { host, vehicle } = await trip();
    const tama = await createHost('tama@example.co.nz');
    await UserModel.updateOne({ _id: tama._id }, { $set: { firstName: 'Tama', lastName: 'Rewi' } });
    const mazda = await createVehicle(tama._id, { make: 'Mazda', model: 'CX-5', status: 'SUSPENDED' });
    const tesla = await createVehicle(tama._id, {
      make: 'Tesla',
      model: 'Model 3',
      year: 2023,
      status: 'DRAFT',
      payoutsReady: false,
    });
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const agent = await staffAgent('sam@example.co.nz');
    const search = (query: Record<string, string>) => agent.get('/api/v1/admin/vehicles/search').query(query);
    const ids = (response: { body: { vehicles: { id: string }[] } }) =>
      response.body.vehicles.map((car) => car.id).sort();

    const all = await search({});
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 3, page: 1 });
    expect(all.body.host).toBeUndefined();

    // Every word must match: the year, make and model, as staff would type the car's name.
    const corolla = await search({ q: '2021 toyota corolla' });
    expect(corolla.body.vehicles).toEqual([
      {
        id: vehicle.id,
        title: '2021 Toyota Corolla',
        status: 'ACTIVE',
        regoPlate: vehicle.regoPlate,
        city: 'Auckland',
        host: { id: host.id, name: 'Hana Tester', email: 'hana@example.co.nz' },
        waitingForPayouts: false,
        hostSuspended: false,
        tripCount: 0,
        updatedAt: expect.any(String),
      },
    ]);
    expect(ids(await search({ q: mazda.regoPlate!.toLowerCase() }))).toEqual([mazda.id]);
    expect(ids(await search({ q: 'tama@example' }))).toEqual([mazda.id, tesla.id].sort());
    expect(ids(await search({ q: 'Tama Rewi' }))).toEqual([mazda.id, tesla.id].sort());
    expect(ids(await search({ status: 'SUSPENDED' }))).toEqual([mazda.id]);
    expect((await search({ q: 'tesla' })).body.vehicles[0]).toMatchObject({
      status: 'DRAFT',
      waitingForPayouts: true,
    });

    // One Host's cars, named for the filter.
    const hosted = await search({ hostId: tama.id });
    expect(ids(hosted)).toEqual([mazda.id, tesla.id].sort());
    expect(hosted.body.host).toEqual({ id: tama.id, name: 'Tama Rewi' });
    expect(ids(await search({ hostId: tama.id, status: 'DRAFT' }))).toEqual([tesla.id]);

    // Search text is matched as text, and bad filters are refused.
    expect((await search({ q: '(.*' })).body.total).toBe(0);
    expect((await search({ hostId: 'nope' })).status).toBe(400);
    expect((await search({ status: 'GONE' })).status).toBe(400);

    // The review queue is unchanged, and the search doesn't hide a car's own page.
    expect((await agent.get('/api/v1/admin/vehicles')).body.vehicles).toEqual([]);
    expect((await agent.get(`/api/v1/admin/vehicles/${mazda.id}`)).body.vehicle.status).toBe('SUSPENDED');
    const guest = browserAgent();
    await guest.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });
    expect((await guest.get('/api/v1/admin/vehicles/search')).status).toBe(403);
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
    // One member's tickets, as a link from their record asks for.
    const theirs = await agent.get(`/api/v1/admin/support/tickets?user=${guest.id}`);
    expect(theirs.body.tickets.map((ticket: { ref: string }) => ticket.ref)).toEqual(['ST-ABC123']);
    const someoneElse = await agent.get(
      `/api/v1/admin/support/tickets?user=${new mongoose.Types.ObjectId()}`,
    );
    expect(someoneElse.body.tickets).toEqual([]);
    expect((await agent.get('/api/v1/admin/support/tickets?user=nope')).status).toBe(400);
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
    // A second flag clears too, once another on the same person has been cleared.
    const secondId = queue.body.users[0].flags[1].id;
    const second = await agent.post(`/api/v1/admin/users/${guest.id}/risk-flags/${secondId}/clear`);
    expect(second.status).toBe(200);
    expect(second.body.user.openRiskFlags).toBe(1);
    const again = await agent.post(`/api/v1/admin/users/${guest.id}/risk-flags/${flagId}/clear`);
    expect(again.status).toBe(404);
  });

  it('sorts everyone flagged by open flags in the database, a page at a time', async () => {
    const flag = (code: string, days: number, cleared = false) => ({
      code,
      createdAt: new Date(Date.now() - days * DAY_MS),
      ...(cleared && { clearedAt: new Date() }),
    });
    // 30 people with one open flag, stored first, then two with more, one of whose flags is cleared.
    for (let index = 0; index < 30; index += 1) {
      await UserModel.collection.insertOne({
        email: `flagged${index}@example.co.nz`,
        firstName: 'Flagged',
        lastName: String(index),
        roles: ['GUEST'],
        status: 'ACTIVE',
        permissions: [],
        agreements: [],
        createdAt: new Date(),
        riskFlags: [flag('BOOKING_VELOCITY', 30 - index)],
      });
    }
    const most = await createUser({ email: 'most@example.co.nz' });
    const two = await createUser({ email: 'two@example.co.nz' });
    await UserModel.updateOne(
      { _id: most._id },
      {
        $set: { riskFlags: [flag('CARD_COUNTRY', 1), flag('RADAR_WARNING', 1), flag('BOOKING_VELOCITY', 2)] },
      },
    );
    await UserModel.updateOne(
      { _id: two._id },
      { $set: { riskFlags: [flag('CARD_COUNTRY', 1), flag('RADAR_WARNING', 1), flag('OLD', 9, true)] } },
    );
    await createStaff();
    const agent = await staffAgent();

    const first = await agent.get('/api/v1/admin/risk');
    expect(first.body).toMatchObject({ total: 32, page: 1, nextPage: 2 });
    expect(first.body.users).toHaveLength(25);
    expect(first.body.users.slice(0, 3).map((user: { email: string }) => user.email)).toEqual([
      'most@example.co.nz',
      'two@example.co.nz',
      'flagged0@example.co.nz',
    ]);
    expect(first.body.users[1].flags).toHaveLength(2);
    const second = await agent.get('/api/v1/admin/risk').query({ page: 2 });
    expect(second.body.users).toHaveLength(7);
    expect(second.body.nextPage).toBeUndefined();
  });
});
