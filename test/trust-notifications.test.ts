import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose, { type Types } from 'mongoose';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type Stripe from 'stripe';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEmail, sendEmail } from '../src/emails/index.js';
import type { Mailer } from '../src/integrations/mailer/index.js';
import { stripe } from '../src/integrations/stripe.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { unreadMessageEmailJob } from '../src/jobs/handlers/message-jobs.js';
import { pickupReminderJob, returnReminderJob } from '../src/jobs/handlers/trip-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { getPlatformSettings } from '../src/modules/admin/platform-settings.service.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { login } from '../src/modules/auth/auth.service.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { runHostReminders } from '../src/modules/hosts/host-reminders.service.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { NotificationModel, type Notification } from '../src/modules/notifications/notification.model.js';
import { smsSendTime } from '../src/modules/notifications/notify.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { documentDobHash, licenceNumberHash } from '../src/modules/users/driver-licence.service.js';
import { syncIdentity } from '../src/modules/users/identity.service.js';
import {
  oneClickUnsubscribeUrl,
  unsubscribeToken,
  unsubscribeUrl,
} from '../src/modules/users/notification-prefs.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { startRealtime, userRoom } from '../src/realtime/realtime.js';
import { encrypt } from '../src/lib/encryption.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle, nzDay } from './fixtures.js';
import {
  FRONTEND_ORIGIN,
  PASSWORD,
  browserAgent,
  createStaff,
  createUser,
  staffAgent,
  testApp,
} from './helpers.js';

/*
 * Trust and notifications: suspended and closed accounts, staff status edits and calendar overrides, the
 * staff overview's figures, licences confirmed by the identity check, duplicate licences, trip and Host
 * reminders on every channel, and unsubscribing from unread-message emails.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;
const client = stripe();

const nzToday = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(
    new Date(Date.now() + offsetDays * DAY_MS),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

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

type Channel = Notification['channel'];
type Stored = Notification & { _id: Types.ObjectId };

/** One person's notifications of a type, by channel. */
async function byChannel(userId: Types.ObjectId, type: string): Promise<Partial<Record<Channel, Stored>>> {
  const found = await NotificationModel.find({ userId, type }).lean<Stored[]>();
  return Object.fromEntries(found.map((notification) => [notification.channel, notification]));
}

/** The queued `notification.send` job that delivers a notification. */
const deliveryJob = (notification: Stored) =>
  JobModel.findOne({
    type: 'notification.send',
    'payload.notificationId': notification._id.toString(),
  }).lean();

const riskCodes = async (userId: Types.ObjectId) =>
  ((await UserModel.findById(userId).lean())?.riskFlags ?? []).map((flag) => flag.code);

describe('a suspended or closed account', () => {
  it('refuses every write with a still-valid access token, while reads work until it expires', async () => {
    const { guest, host, vehicle, booking } = await trip();
    const guestAgent = await signIn('kiri@example.co.nz');
    await createStaff();
    const staff = await staffAgent();
    const send = (body: string) => guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body });
    expect((await send('Kia ora')).status).toBe(201);

    const suspended = await staff
      .post(`/api/v1/admin/users/${guest.id}/suspend`)
      .send({ reason: 'Uploaded someone else’s licence' });
    expect(suspended.status).toBe(200);

    // Every kind of write is refused at once.
    const message = await send('Still there?');
    expect(message.status).toBe(401);
    expect(message.body.error.code).toBe('UNAUTHENTICATED');
    expect((await guestAgent.patch('/api/v1/me').send({ firstName: 'Kiri' })).status).toBe(401);
    expect((await guestAgent.put(`/api/v1/me/favourites/${vehicle.id}`)).status).toBe(401);
    expect((await guestAgent.delete(`/api/v1/me/favourites/${vehicle.id}`)).status).toBe(401);
    expect((await guestAgent.post(`/api/v1/users/${host.id}/block`)).status).toBe(401);
    expect(await MessageModel.countDocuments({ body: 'Still there?' })).toBe(0);
    expect((await UserModel.findById(guest._id).lean())!.firstName).toBe('Kiri');

    // Reads still work until the token runs out: the suspension notice is on the bell.
    const bell = await guestAgent.get('/api/v1/notifications');
    expect(bell.status).toBe(200);
    expect(bell.body.notifications[0]).toMatchObject({ title: 'Your account is suspended' });
    expect((await guestAgent.get(`/api/v1/threads/${booking.ref}/messages`)).status).toBe(200);

    // Lifted: the same token can write again.
    expect((await staff.post(`/api/v1/admin/users/${guest.id}/unsuspend`)).status).toBe(200);
    expect((await send('Back again')).status).toBe(201);
  });

  it('emails the closure to the member’s own address before anonymising, and turns every optional email off', async () => {
    const guest = await createUser();
    const guestAgent = await signIn('kiri@example.co.nz');
    await createStaff();
    const staff = await staffAgent();

    expect((await staff.post(`/api/v1/admin/users/${guest.id}/close`)).status).toBe(200);

    const jobs = await JobModel.find({ type: 'email.send', 'payload.template': 'tripNotice' }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      to: 'kiri@example.co.nz',
      template: 'tripNotice',
      props: {
        firstName: 'Kiri',
        heading: 'Your Rento Vroom account is closed',
        url: 'http://localhost:5173/privacy',
      },
    });
    const closed = await UserModel.findById(guest._id).lean();
    expect(closed!.email).toMatch(/@closed\.rentovroom\.invalid$/);
    expect(closed!.notificationPrefs).toEqual({
      marketingEmail: false,
      marketingSms: false,
      unreadMessageSms: false,
      unreadMessageEmail: false,
    });
    // The closed account's token can't change anything.
    const prefs = await guestAgent.patch('/api/v1/me/notification-prefs').send({ marketingEmail: true });
    expect(prefs.status).toBe(401);
    expect((await UserModel.findById(guest._id).lean())!.notificationPrefs.marketingEmail).toBe(false);
  });
});

describe('staff marking a trip started or completed', () => {
  it('tells both parties in the chat and on the bell, as a check-in and check-out in the app would', async () => {
    const { guest, host, booking } = await trip({ startAt: new Date(Date.now() - HOUR_MS) });
    await createStaff();
    const staff = await staffAgent();
    const systemMessages = async () => {
      const thread = await ThreadModel.findOne({ bookingId: booking._id });
      if (!thread) return [];
      const messages = await MessageModel.find({ threadId: thread._id, systemGenerated: true }).sort({
        createdAt: 1,
      });
      return messages.map((message) => message.body);
    };

    const started = await staff
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'ACTIVE', reason: 'Checked in on paper' });
    expect(started.status).toBe(200);
    expect(await systemMessages()).toEqual([
      expect.stringMatching(
        /^Rento Vroom support marked this trip as started at .+ \(NZ time\)\. The return is due .+\.$/,
      ),
    ]);
    const guestStart = await byChannel(guest._id, 'TRIP_STARTED');
    const hostStart = await byChannel(host._id, 'TRIP_STARTED');
    expect(guestStart.IN_APP!.payload).toMatchObject({
      title: 'Your trip has started',
      body: expect.stringMatching(
        /^Rento Vroom support marked your trip in the 2021 Toyota Corolla as started/,
      ),
      link: `/trips/${booking.ref}`,
    });
    expect(hostStart.IN_APP!.payload).toMatchObject({
      title: 'The trip has started',
      link: `/host/bookings/${booking.ref}`,
    });

    const completed = await staff
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'COMPLETED', reason: 'Car returned, app was down' });
    expect(completed.status).toBe(200);
    expect(await systemMessages()).toEqual([
      expect.stringMatching(/as started/),
      expect.stringMatching(/^Rento Vroom support marked this trip as completed at .+ \(NZ time\)\.$/),
    ]);
    expect(await NotificationModel.countDocuments({ type: 'TRIP_COMPLETED', channel: 'IN_APP' })).toBe(2);
    // Still one start notice each.
    expect(await NotificationModel.countDocuments({ type: 'TRIP_STARTED', channel: 'IN_APP' })).toBe(2);
  });

  it('says nothing to anyone when the change is refused', async () => {
    const { booking } = await trip({ startAt: new Date(Date.now() + 3 * DAY_MS) });
    await createStaff();
    const staff = await staffAgent();

    const early = await staff
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'ACTIVE', reason: 'Checked in on paper' });
    expect(early.body.error.code).toBe('TOO_EARLY');
    const notStarted = await staff
      .post(`/api/v1/admin/bookings/${booking.id}/status`)
      .send({ to: 'COMPLETED', reason: 'Car returned' });
    expect(notStarted.body.error.code).toBe('TRANSITION_NOT_ALLOWED');

    expect(await MessageModel.countDocuments({ systemGenerated: true })).toBe(0);
    expect(
      await NotificationModel.countDocuments({
        type: mongoose.trusted({ $in: ['TRIP_STARTED', 'TRIP_COMPLETED'] }),
      }),
    ).toBe(0);
  });
});

describe('staff calendar overrides', () => {
  it('write each block and unblock to the audit log with its dates', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const admin = await createStaff();
    const staff = await staffAgent();

    const blocked = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/blocks`)
      .send({ start: nzDay(20), end: nzDay(21), note: 'Recall repair' });
    expect(blocked.status).toBe(201);
    const { block } = blocked.body;
    const entry = await AuditLogModel.findOne({ action: 'calendar.blocked' }).lean();
    expect(entry).toMatchObject({
      entity: 'vehicle',
      entityId: vehicle.id,
      after: { blockId: block.id, start: block.start, end: block.end, note: 'Recall repair' },
    });
    expect(String(entry!.actorId)).toBe(admin.id);

    // A block without a note records none.
    const plain = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/blocks`)
      .send({ start: nzDay(25), end: nzDay(26) });
    const plainEntry = await AuditLogModel.findOne({
      action: 'calendar.blocked',
      'after.blockId': plain.body.block.id,
    }).lean();
    expect(plainEntry!.after).toEqual({
      blockId: plain.body.block.id,
      start: plain.body.block.start,
      end: plain.body.block.end,
    });

    expect((await staff.delete(`/api/v1/admin/vehicles/${vehicle.id}/blocks/${block.id}`)).status).toBe(204);
    expect(await AvailabilityBlockModel.countDocuments({ _id: block.id })).toBe(0);
    const unblocked = await AuditLogModel.findOne({ action: 'calendar.unblocked' }).lean();
    expect(unblocked).toMatchObject({
      entity: 'vehicle',
      entityId: vehicle.id,
      before: {
        blockId: block.id,
        reason: 'ADMIN',
        start: block.start,
        end: block.end,
        note: 'Recall repair',
      },
    });
    expect(String(unblocked!.actorId)).toBe(admin.id);
  });

  it('records no unblock when there was nothing to remove', async () => {
    const { vehicle, booking } = await trip();
    await createStaff();
    const staff = await staffAgent();
    const bookingBlock = await AvailabilityBlockModel.create({
      vehicleId: vehicle._id,
      startAt: booking.startAt,
      endAt: booking.endAt,
      reason: 'BOOKED',
      bookingId: booking._id,
    });

    const missing = await staff.delete(
      `/api/v1/admin/vehicles/${vehicle.id}/blocks/${new mongoose.Types.ObjectId().toString()}`,
    );
    expect(missing.status).toBe(404);
    // A booking isn't a block staff can remove.
    expect(
      (await staff.delete(`/api/v1/admin/vehicles/${vehicle.id}/blocks/${bookingBlock.id}`)).status,
    ).toBe(404);
    expect(await AvailabilityBlockModel.countDocuments({ _id: bookingBlock._id })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'calendar.unblocked' })).toBe(0);
  });
});

describe('the staff overview', () => {
  it('counts only the cars Guests can find and book', async () => {
    const host = await createHost();
    await createVehicle(host._id);
    await createVehicle(host._id, { payoutsReady: false });
    await createVehicle(host._id, { hostSuspended: true });
    await createVehicle(host._id, { status: 'INACTIVE' });
    await createVehicle(host._id, { status: 'SUSPENDED' });
    await createVehicle(host._id, { payoutsReady: true });
    await createStaff();

    const dashboard = await (await staffAgent()).get('/api/v1/admin/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.figures).toMatchObject({ activeVehicles: 2, suspendedVehicles: 1 });
  });

  /**
   * The admin-reports money: a trip starting tomorrow with a $23 goodwill refund and a $46 extra charge,
   * and a booking cancelled today keeping $115 (the rest refunded).
   */
  async function money() {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    const now = new Date();
    const booked = await createBookingRecord(parties, { startAt: new Date(Date.now() + DAY_MS) });
    await createPaymentRecord(booked, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        { amountCents: 2300, reason: 'Goodwill', fundedBy: 'PLATFORM', status: 'SUCCEEDED', createdAt: now },
      ],
    });
    const extraChargeId = new mongoose.Types.ObjectId();
    await createPaymentRecord(booked, { type: 'EXTRA_CHARGE', extraChargeId, amountCents: 4600 });
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booked._id,
      type: 'EXTRA_CHARGE',
      extraChargeId,
      amountCents: 3680,
      grossCents: 4600,
      commissionCents: 920,
      commissionGstCents: 120,
      status: 'SCHEDULED',
      scheduledFor: now,
    });
    const cancelled = await createBookingRecord(parties, {
      status: 'CANCELLED',
      cancelledAt: now,
      cancellationReason: 'GUEST_CANCELLED',
      cancellationFeeCents: 11500,
      refundCents: 22370,
      hostShareCents: 6000,
    });
    await createPaymentRecord(cancelled, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 22370,
          reason: 'Cancellation (GUEST_CANCELLED)',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'SUCCEEDED',
          createdAt: now,
        },
      ],
    });
  }

  it('shows the same booking revenue and platform fees as the report for the same dates', async () => {
    await money();
    await createStaff();
    const admin = await staffAgent();
    const range = { from: nzToday(), to: nzToday(5) };

    const { report } = (await admin.get('/api/v1/admin/reports/summary').query(range)).body;
    const dashboard = await admin.get('/api/v1/admin/dashboard').query(range);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toMatchObject(range);
    // Booking revenue is the report's money less the refunds of it (checked to the cent in the next test).
    expect(dashboard.body.figures.bookingRevenueCents).toBeLessThanOrEqual(
      report.money.grossBookingsCents +
        report.money.extraChargesCents +
        report.money.cancellationFeesKeptCents,
    );
    expect(dashboard.body.figures.platformFeesCents).toBe(report.fees.totalCents);
    expect(dashboard.body.figures.platformFeesCents).toBe(2670 + 5340 + 5500 + 920);

    // A range without any of it shows none.
    const earlier = { from: nzToday(-20), to: nzToday(-10) };
    const quiet = (await admin.get('/api/v1/admin/dashboard').query(earlier)).body.figures;
    expect(quiet).toMatchObject({ bookingRevenueCents: 0, platformFeesCents: 0 });
  });

  // A cancellation's own refund is already out of the fee kept: only refunds of counted money come off.
  it('doesn’t take a cancellation’s own refund off booking revenue twice', async () => {
    await money();
    await createStaff();
    const admin = await staffAgent();
    const dashboard = await admin.get('/api/v1/admin/dashboard').query({ from: nzToday(), to: nzToday(5) });
    // $338.70 trip + $46 extra charge + $115 kept − $23 goodwill refund.
    expect(dashboard.body.figures.bookingRevenueCents).toBe(33870 + 4600 + 11500 - 2300);
  });

  it('counts the same people the Verifications queue lists', async () => {
    const pendingLicence = (number: string) => ({
      number: encrypt(number),
      numberHash: licenceNumberHash(number),
      numberEnding: number.slice(-3),
      version: '123',
      country: 'New Zealand',
      class: 'NZ_FULL',
      issuedAt: new Date('2012-05-01T00:00:00+12:00'),
      expiry: new Date('2034-05-01T00:00:00+12:00'),
      status: 'PENDING',
    });
    const inReview = await createUser({ email: 'rewi@example.co.nz' });
    await UserModel.updateOne(
      { _id: inReview._id },
      { $set: { identityVerification: { status: 'PENDING', providerRef: 'vs_review' } } },
    );
    const passport = await createUser({ email: 'mere@example.co.nz' });
    await UserModel.updateOne(
      { _id: passport._id },
      {
        $set: {
          identityVerification: { status: 'APPROVED', documentType: 'passport' },
          driverLicence: pendingLicence('AB111111'),
        },
      },
    );
    // Licence details with no identity check yet: queued only when no check is needed before booking.
    const noCheck = await createUser({ email: 'tama@example.co.nz' });
    await UserModel.updateOne({ _id: noCheck._id }, { $set: { driverLicence: pendingLicence('AB222222') } });
    // A closed account is never waiting.
    const closed = await createUser({ email: 'gone@example.co.nz' });
    await UserModel.updateOne(
      { _id: closed._id },
      {
        $set: { closedAt: new Date(), identityVerification: { status: 'PENDING', providerRef: 'vs_closed' } },
      },
    );
    await createStaff();
    const staff = await staffAgent();
    const counts = async () => {
      const queue = (await staff.get('/api/v1/admin/verifications')).body.items as { userId: string }[];
      const { figures, queues } = (await staff.get('/api/v1/admin/dashboard')).body;
      return { queued: queue.map((item) => item.userId).sort(), figures, queues };
    };

    const required = await counts();
    expect(required.queued).toEqual([inReview.id, passport.id].sort());
    expect(required.figures.pendingVerifications).toBe(2);
    expect(required.queues.verifications).toBe(2);

    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { verification: { identityBeforeFirstBooking: false } },
    });
    const optional = await counts();
    expect(optional.queued).toEqual([inReview.id, passport.id, noCheck.id].sort());
    expect(optional.figures.pendingVerifications).toBe(3);
    expect(optional.queues.verifications).toBe(3);
  });
});

describe('licences and the identity check', () => {
  let session: Partial<Stripe.Identity.VerificationSession> = {};
  let report: Partial<Stripe.Identity.VerificationReport> = {};

  beforeEach(() => {
    session = { id: 'vs_1', status: 'requires_input', url: 'https://verify.stripe.com/start/abc' };
    report = {};
    vi.spyOn(client.identity.verificationSessions, 'create').mockImplementation(
      async () => session as Stripe.Response<Stripe.Identity.VerificationSession>,
    );
    vi.spyOn(client.identity.verificationSessions, 'retrieve').mockImplementation(
      async () => session as Stripe.Response<Stripe.Identity.VerificationSession>,
    );
    vi.spyOn(client.identity.verificationReports, 'retrieve').mockImplementation(
      async () => report as Stripe.Response<Stripe.Identity.VerificationReport>,
    );
  });

  const licenceReport = (number: string, dob = { year: 1990, month: 4, day: 21 }) =>
    ({
      id: 'vr_1',
      document: { type: 'driving_license', number, dob },
    }) as unknown as Partial<Stripe.Identity.VerificationReport>;

  const licence = (number = 'AB123456', dob = '1990-04-21') => ({
    number,
    version: '123',
    class: 'NZ_FULL',
    issuedAt: '2012-05-01',
    expiry: '2034-05-01',
    dob,
  });

  async function guest(email = 'kiri@example.co.nz') {
    const user = await createUser({ email });
    return { user, agent: await signIn(email) };
  }

  /** The person passes Stripe's check with a driver licence, before entering any licence details. */
  async function passCheck(
    user: { _id: Types.ObjectId },
    agent: ReturnType<typeof browserAgent>,
    number = 'AB123456',
    sessionId = 'vs_1',
  ) {
    session = { id: sessionId, status: 'requires_input', url: 'https://verify.stripe.com/start/abc' };
    expect((await agent.post('/api/v1/me/verification').send({})).status).toBe(200);
    session = { ...session, status: 'verified', last_verification_report: 'vr_1' };
    report = licenceReport(number);
    return syncIdentity(user._id.toString());
  }

  it('keeps what the ID showed, its date of birth too, when the account has no date of birth yet', async () => {
    const { user, agent } = await guest();
    expect((await passCheck(user, agent)).status).toBe('APPROVED');

    const identity = (await UserModel.findById(user._id).lean())!.identityVerification!;
    expect(identity).toMatchObject({
      status: 'APPROVED',
      documentType: 'driving_license',
      documentNumberHash: licenceNumberHash('AB123456'),
      documentDobHash: documentDobHash('1990-04-21'),
    });
    expect(identity.documentDobMatched).toBeUndefined();
  });

  it('approves a licence entered after the ID check with the same number and date of birth', async () => {
    const { user, agent } = await guest();
    await passCheck(user, agent);

    const saved = await agent.put('/api/v1/me/driver-licence').send(licence());
    expect(saved.status).toBe(200);
    expect(saved.body.licence.status).toBe('APPROVED');
    expect(saved.body.licenceInReview).toBe(false);
    const fresh = (await UserModel.findById(user._id).lean())!;
    expect(fresh.driverLicence!.status).toBe('APPROVED');
    expect(fresh.identityVerification!.documentDobMatched).toBe(true);

    // Nothing for support to check.
    await createStaff();
    expect((await (await staffAgent()).get('/api/v1/admin/verifications')).body.items).toEqual([]);
  });

  it('sends a licence with another number to support', async () => {
    const { user, agent } = await guest();
    await passCheck(user, agent);

    const saved = await agent.put('/api/v1/me/driver-licence').send(licence('ZZ999999'));
    expect(saved.body.licence.status).toBe('PENDING');
    expect(saved.body.licenceInReview).toBe(true);
    await createStaff();
    expect((await (await staffAgent()).get('/api/v1/admin/verifications')).body.items).toEqual([
      expect.objectContaining({
        userId: user.id,
        kind: 'LICENCE',
        identity: expect.objectContaining({ licenceNumberMatched: false }),
      }),
    ]);
  });

  it('sends a licence with another date of birth to support, and says the date didn’t match', async () => {
    const { user, agent } = await guest();
    await passCheck(user, agent);

    const saved = await agent.put('/api/v1/me/driver-licence').send(licence('AB123456', '1991-04-21'));
    expect(saved.body.licence.status).toBe('PENDING');
    expect(saved.body.licenceInReview).toBe(true);
    expect((await UserModel.findById(user._id).lean())!.identityVerification!.documentDobMatched).toBe(false);
    await createStaff();
    expect((await (await staffAgent()).get('/api/v1/admin/verifications')).body.items).toEqual([
      expect.objectContaining({
        userId: user.id,
        kind: 'LICENCE',
        identity: expect.objectContaining({ licenceNumberMatched: true, dobMatched: false }),
      }),
    ]);
  });

  it('doesn’t approve a check whose report can’t be read, and the account page still answers', async () => {
    const { user, agent } = await guest();
    expect((await agent.post('/api/v1/me/verification').send({})).status).toBe(200);
    session = { ...session, status: 'verified', last_verification_report: 'vr_1' };
    vi.spyOn(client.identity.verificationReports, 'retrieve').mockRejectedValue(new Error('Stripe is down'));

    await expect(syncIdentity(user.id)).rejects.toThrow('Stripe is down');
    expect((await UserModel.findById(user._id).lean())!.identityVerification).toMatchObject({
      status: 'NONE',
      sessionStatus: 'requires_input',
    });
    expect(await NotificationModel.countDocuments({ type: 'IDENTITY_APPROVED' })).toBe(0);

    const page = await agent.get('/api/v1/me/verification');
    expect(page.status).toBe(200);
    expect(page.body.identity).toEqual({ status: 'NONE', sessionStatus: 'requires_input' });

    // Once Stripe answers, the next look approves it.
    report = licenceReport('AB123456');
    vi.spyOn(client.identity.verificationReports, 'retrieve').mockImplementation(
      async () => report as Stripe.Response<Stripe.Identity.VerificationReport>,
    );
    expect((await agent.get('/api/v1/me/verification')).body.identity.status).toBe('APPROVED');
  });

  it('flags the same licence on two accounts, once each however often it’s saved', async () => {
    const first = await guest('kiri@example.co.nz');
    const second = await guest('tama@example.co.nz');
    expect((await first.agent.put('/api/v1/me/driver-licence').send(licence())).status).toBe(200);
    expect(await riskCodes(first.user._id)).toEqual([]);

    expect((await second.agent.put('/api/v1/me/driver-licence').send(licence())).status).toBe(200);
    expect(await riskCodes(first.user._id)).toEqual(['DUPLICATE_LICENCE']);
    expect(await riskCodes(second.user._id)).toEqual(['DUPLICATE_LICENCE']);

    await second.agent.put('/api/v1/me/driver-licence').send({ ...licence(), expiry: '2035-05-01' });
    await first.agent.put('/api/v1/me/driver-licence').send(licence());
    expect(await riskCodes(first.user._id)).toEqual(['DUPLICATE_LICENCE']);
    expect(await riskCodes(second.user._id)).toEqual(['DUPLICATE_LICENCE']);
  });

  it('flags a licence an ID check read that is on another account, on both accounts', async () => {
    const first = await guest('kiri@example.co.nz');
    const second = await guest('tama@example.co.nz');
    await first.agent.put('/api/v1/me/driver-licence').send(licence('ZZ999999'));

    expect((await passCheck(second.user, second.agent, 'ZZ999999', 'vs_2')).status).toBe('APPROVED');
    expect(await riskCodes(first.user._id)).toEqual(['DUPLICATE_LICENCE']);
    expect(await riskCodes(second.user._id)).toEqual(['DUPLICATE_LICENCE']);

    // Entering that licence afterwards raises nothing more while the flags are open.
    await second.agent.put('/api/v1/me/driver-licence').send(licence('ZZ999999'));
    expect(await riskCodes(first.user._id)).toEqual(['DUPLICATE_LICENCE']);
    expect(await riskCodes(second.user._id)).toEqual(['DUPLICATE_LICENCE']);
  });

  it('raises no flag for an ID check that read a licence no other account has', async () => {
    const first = await guest('kiri@example.co.nz');
    const second = await guest('tama@example.co.nz');
    await first.agent.put('/api/v1/me/driver-licence').send(licence('AB123456'));
    await passCheck(second.user, second.agent, 'ZZ999999', 'vs_2');
    expect(await riskCodes(first.user._id)).toEqual([]);
    expect(await riskCodes(second.user._id)).toEqual([]);
  });
});

describe('pickup and return reminders', () => {
  /** A trip whose Guest and Host both have a verified mobile. */
  async function phoneTrip(overrides: Parameters<typeof createBookingRecord>[1]) {
    const parties = await trip(overrides);
    await UserModel.updateOne(
      { _id: parties.guest._id },
      { $set: { phone: '+64211112222', phoneVerifiedAt: new Date() } },
    );
    await UserModel.updateOne(
      { _id: parties.host._id },
      { $set: { phone: '+64213334444', phoneVerifiedAt: new Date() } },
    );
    return parties;
  }

  it('24 hours before pick-up: email and text to each side, the text held for quiet hours and dropped once stale', async () => {
    const { guest, host, booking } = await phoneTrip({ startAt: new Date(Date.now() + DAY_MS) });
    const { sms } = await getPlatformSettings();
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 24 }, context);

    for (const [person, role] of [
      [guest, 'GUEST'],
      [host, 'HOST'],
    ] as const) {
      const sent = await byChannel(person._id, 'PICKUP_REMINDER');
      expect(Object.keys(sent).sort()).toEqual(['EMAIL', 'IN_APP', 'SMS']);
      expect(sent.EMAIL!.payload).toMatchObject({
        template: 'tripReminder',
        props: { role, kind: 'PICKUP', ref: booking.ref, inWords: 'Tomorrow' },
      });
      expect(sent.SMS!.payload).toEqual({
        body: expect.stringContaining(booking.vehicleSnapshot.title),
        whileBooking: { id: booking.id, statuses: ['CONFIRMED'] },
        expiresAt: booking.startAt,
      });
      // Not urgent: sent now, or at the end of quiet hours.
      const job = await deliveryJob(sent.SMS!);
      const expected = smsSendTime(sent.SMS!.createdAt, sms.quietHoursStart, sms.quietHoursEnd);
      expect(Math.abs(job!.runAt.getTime() - expected.getTime())).toBeLessThan(5_000);
    }

    // Once only.
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 24 }, context);
    expect(await NotificationModel.countDocuments({ type: 'PICKUP_REMINDER' })).toBe(6);
  });

  it('2 hours before pick-up: email and an urgent text to each side', async () => {
    const { guest, host, booking } = await phoneTrip({ startAt: new Date(Date.now() + 2 * HOUR_MS) });
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 2 }, context);

    for (const [person, role, url] of [
      [guest, 'GUEST', `/trips/${booking.ref}`],
      [host, 'HOST', `/host/bookings/${booking.ref}`],
    ] as const) {
      const sent = await byChannel(person._id, 'PICKUP_REMINDER');
      expect(Object.keys(sent).sort()).toEqual(['EMAIL', 'IN_APP', 'SMS']);
      expect(sent.EMAIL!.payload).toMatchObject({
        template: 'tripReminder',
        props: { role, kind: 'PICKUP', inWords: 'In 2 hours', url: `http://localhost:5173${url}` },
      });
      expect(sent.SMS!.payload).toMatchObject({
        body: expect.stringContaining(`http://localhost:5173${url}`),
        whileBooking: { id: booking.id, statuses: ['CONFIRMED'] },
        expiresAt: booking.startAt,
      });
      // Urgent: straight away, even in quiet hours.
      const job = await deliveryJob(sent.SMS!);
      expect(job!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it('2 hours before the return: email and text to the Guest and the Host', async () => {
    const start = new Date(Date.now() - 2 * DAY_MS);
    const { guest, host, booking } = await phoneTrip({
      status: 'ACTIVE',
      startAt: start,
      endAt: new Date(Date.now() + 2 * HOUR_MS),
    });
    await returnReminderJob({ bookingId: booking.id, hoursBefore: 2 }, context);

    for (const [person, role] of [
      [guest, 'GUEST'],
      [host, 'HOST'],
    ] as const) {
      const sent = await byChannel(person._id, 'RETURN_REMINDER');
      expect(Object.keys(sent).sort()).toEqual(['EMAIL', 'IN_APP', 'SMS']);
      expect(sent.EMAIL!.payload).toMatchObject({
        template: 'tripReminder',
        props: { role, kind: 'RETURN', ref: booking.ref, inWords: 'In 2 hours' },
      });
      expect(sent.SMS!.payload).toEqual({
        body: expect.stringContaining('check-out'),
        whileBooking: { id: booking.id, statuses: ['CONFIRMED', 'ACTIVE'] },
        expiresAt: booking.endAt,
      });
    }
    expect((await byChannel(host._id, 'RETURN_REMINDER')).IN_APP!.payload).toMatchObject({
      title: `In 2 hours: Kiri returns your ${booking.vehicleSnapshot.title}`,
      link: `/host/bookings/${booking.ref}`,
    });

    // A finished trip gets no reminder.
    await NotificationModel.deleteMany({});
    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'COMPLETED' } });
    await returnReminderJob({ bookingId: booking.id, hoursBefore: 1 }, context);
    expect(await NotificationModel.countDocuments({})).toBe(0);
  });

  it('texts no one without a verified mobile', async () => {
    const { guest, host, booking } = await trip({ startAt: new Date(Date.now() + 2 * HOUR_MS) });
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 2 }, context);
    expect(Object.keys(await byChannel(guest._id, 'PICKUP_REMINDER')).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(Object.keys(await byChannel(host._id, 'PICKUP_REMINDER')).sort()).toEqual(['EMAIL', 'IN_APP']);
  });
});

describe('daily Host reminders', () => {
  /** A car whose last check-out read 45,000 km. */
  async function carAt45000(overrides: Parameters<typeof createVehicle>[1] = {}) {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id, overrides);
    const earlier = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'COMPLETED', startAt: new Date(Date.now() - 20 * DAY_MS) },
    );
    await ConditionReportModel.create({
      bookingId: earlier._id,
      stage: 'CHECK_OUT',
      submittedBy: guest._id,
      odometer: 45_000,
      fuelOrBatteryPct: 80,
      photos: [],
    });
    return { host, guest, vehicle };
  }

  it('email the Host when the Road User Charges licence is running out, once', async () => {
    const { host, vehicle } = await carAt45000({ fuelType: 'DIESEL', rucValidToKm: 45_600 });

    await runHostReminders();
    const sent = await byChannel(host._id, 'RUC_RUNNING_OUT');
    expect(Object.keys(sent).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(sent.EMAIL!.payload).toMatchObject({
      template: 'tripNotice',
      props: {
        firstName: 'Hana',
        heading: "Your 2021 Toyota Corolla's Road User Charges are running out",
        url: `http://localhost:5173/host/vehicles/${vehicle.id}/2`,
      },
    });
    expect(await deliveryJob(sent.EMAIL!)).not.toBeNull();

    await runHostReminders();
    expect(await NotificationModel.countDocuments({ type: 'RUC_RUNNING_OUT' })).toBe(2);
  });

  it('remind about maintenance again when its due date or reading is changed', async () => {
    const { host, vehicle } = await carAt45000({
      maintenanceReminders: [
        { title: 'Service', dueAt: new Date(Date.now() + 3 * DAY_MS) },
        { title: 'New tyres', dueOdometer: 45_200 },
      ],
    });
    const reminders = () =>
      NotificationModel.countDocuments({ userId: host._id, type: 'MAINTENANCE_DUE', channel: 'IN_APP' });

    await runHostReminders();
    expect(await reminders()).toBe(2);
    await runHostReminders();
    expect(await reminders()).toBe(2);

    await VehicleModel.updateOne(
      { _id: vehicle._id },
      { $set: { 'maintenanceReminders.0.dueAt': new Date(Date.now() + 5 * DAY_MS) } },
    );
    await runHostReminders();
    expect(await reminders()).toBe(3);

    await VehicleModel.updateOne(
      { _id: vehicle._id },
      { $set: { 'maintenanceReminders.1.dueOdometer': 45_300 } },
    );
    await runHostReminders();
    expect(await reminders()).toBe(4);
    expect(await NotificationModel.countDocuments({ type: 'MAINTENANCE_DUE', channel: 'EMAIL' })).toBe(4);
  });

  it('still check a suspended car’s documents when it has a booked trip', async () => {
    const host = await createHost();
    const guest = await createUser();
    const admin = await createStaff();
    const vehicle = await createVehicle(host._id, {
      status: 'SUSPENDED',
      wofExpiry: new Date(Date.now() + 2 * DAY_MS),
    });
    const booking = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { startAt: new Date(Date.now() + 1.5 * DAY_MS), endAt: new Date(Date.now() + 4 * DAY_MS) },
    );

    await runHostReminders();
    expect((await byChannel(host._id, 'DOCUMENT_EXPIRING')).IN_APP!.payload).toMatchObject({
      title: expect.stringMatching(/^2021 Toyota Corolla: WOF expires/),
    });
    const beforeTrip = await byChannel(host._id, 'DOCUMENT_BEFORE_TRIP');
    expect(Object.keys(beforeTrip).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(beforeTrip.IN_APP!.payload).toMatchObject({ title: `WOF runs out before ${booking.ref} ends` });
    // Within 72 hours of the trip: support is told too.
    expect(
      await NotificationModel.countDocuments({
        userId: admin._id,
        type: 'DOCUMENT_BEFORE_TRIP',
        channel: 'IN_APP',
      }),
    ).toBe(1);
  });
});

describe('emails', () => {
  const cancelled = {
    firstName: 'Kiri',
    ref: 'RV-7K2Q9M',
    vehicleTitle: '2021 Toyota Corolla',
    start: 'Mon, 12 Oct 2026, 10:00 am',
    end: 'Thu, 15 Oct 2026, 10:00 am',
    url: 'http://localhost:5173/trips/RV-7K2Q9M',
    audience: 'GUEST' as const,
    refund: '$338.70',
  };

  it('tells the Guest a Host cancellation is refunded in full', async () => {
    const email = await renderEmail('bookingCancelled', { ...cancelled, cancelledBy: 'HOST' });
    expect(email.subject).toBe('Booking RV-7K2Q9M is cancelled');
    expect(email.text).toContain('your host cancelled booking RV-7K2Q9M');
    expect(email.text).toContain('You get a full refund of $338.70.');

    const own = await renderEmail('bookingCancelled', { ...cancelled, cancelledBy: 'GUEST', fee: '$115.00' });
    expect(own.text).not.toContain('full refund');
    expect(own.text).toContain('Refunds go back to the card you paid with');
  });

  async function resetPassword() {
    const post = (path: string, body: object) =>
      request(testApp()).post(`/api/v1${path}`).set('Origin', FRONTEND_ORIGIN).send(body);
    await post('/auth/forgot-password', { email: 'kiri@example.co.nz' });
    const job = await JobModel.findOne({ 'payload.template': 'resetPassword' }).lean();
    const url = (job!.payload as { props: { resetUrl: string } }).props.resetUrl;
    const reset = await post('/auth/reset-password', {
      token: new URL(url).searchParams.get('token'),
      password: 'kererū over the bush',
    });
    expect(reset.status).toBe(200);
  }

  it('welcomes someone whose reset link confirmed their email address', async () => {
    await createUser();
    await resetPassword();
    expect(await JobModel.countDocuments({ type: 'email.send', 'payload.template': 'passwordChanged' })).toBe(
      1,
    );
    const welcome = await JobModel.find({ type: 'email.send', 'payload.template': 'welcome' }).lean();
    expect(welcome).toHaveLength(1);
    expect(welcome[0]!.payload).toMatchObject({
      to: 'kiri@example.co.nz',
      props: { firstName: 'Kiri', browseUrl: 'http://localhost:5173' },
    });
  });

  it('doesn’t welcome someone already verified who resets their password', async () => {
    const user = await createUser();
    await UserModel.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
    await resetPassword();
    expect(await JobModel.countDocuments({ type: 'email.send', 'payload.template': 'passwordChanged' })).toBe(
      1,
    );
    expect(await JobModel.countDocuments({ 'payload.template': 'welcome' })).toBe(0);
  });

  it('sends List-Unsubscribe headers when asked, and none otherwise', async () => {
    const send = vi.fn<Mailer['send']>().mockResolvedValue({ id: 'm_1', provider: 'console' });
    const mailer: Mailer = { provider: 'console', send };
    const props = {
      firstName: 'Hana',
      senderFirstName: 'Kiri',
      vehicleTitle: '2021 Toyota Corolla',
      ref: 'RV-7K2Q9M',
      snippet: 'See you at 10',
      count: 1,
      url: 'http://localhost:5173/messages/RV-7K2Q9M',
      unsubscribeUrl: 'http://localhost:5173/unsubscribe?token=abc',
    };
    const link = 'http://localhost:4000/api/v1/notifications/unsubscribe?token=abc';

    await sendEmail(
      { to: 'hana@example.co.nz', template: 'newMessage', props, listUnsubscribe: link },
      mailer,
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'hana@example.co.nz',
        subject: 'New message from Kiri',
        headers: {
          'List-Unsubscribe': `<${link}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    );
    expect(send.mock.calls[0]![0].html).toContain('http://localhost:5173/unsubscribe?token=abc');

    await sendEmail({ to: 'hana@example.co.nz', template: 'newMessage', props }, mailer);
    expect(send.mock.calls[1]![0]).not.toHaveProperty('headers');
  });
});

describe('unread-message emails and unsubscribing', () => {
  it('shows the unread-message email choice, on for an account saved before it existed', async () => {
    const user = await createUser();
    await UserModel.collection.updateOne(
      { _id: user._id },
      { $unset: { 'notificationPrefs.unreadMessageEmail': '' } },
    );
    const agent = await signIn('kiri@example.co.nz');
    expect((await agent.get('/api/v1/me/notification-prefs')).body.prefs).toEqual({
      marketingEmail: false,
      marketingSms: false,
      unreadMessageSms: false,
      unreadMessageEmail: true,
    });

    const off = await agent.patch('/api/v1/me/notification-prefs').send({ unreadMessageEmail: false });
    expect(off.body.prefs).toEqual({
      marketingEmail: false,
      marketingSms: false,
      unreadMessageSms: false,
      unreadMessageEmail: false,
    });
    expect(
      (await agent.patch('/api/v1/me/notification-prefs').send({ unreadMessageEmail: 'no' })).status,
    ).toBe(400);
  });

  it('turns off marketing or unread-message emails, whichever the link is for, without signing in', async () => {
    const user = await createUser();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { notificationPrefs: { marketingEmail: true, marketingSms: true, unreadMessageSms: true } } },
    );
    const prefs = async () => (await UserModel.findById(user._id).lean())!.notificationPrefs;
    const unsubscribe = (token: string) =>
      browserAgent().post('/api/v1/notifications/unsubscribe').send({ token });

    const messages = await unsubscribe(unsubscribeToken(user.id, 'MESSAGE_EMAILS'));
    expect(messages.status).toBe(200);
    expect(messages.body).toEqual({ unsubscribedFrom: 'MESSAGE_EMAILS' });
    expect(await prefs()).toEqual({
      marketingEmail: true,
      marketingSms: true,
      unreadMessageSms: true,
      unreadMessageEmail: false,
    });

    // The marketing link is the two-part one the first emails carried.
    const marketingToken = unsubscribeToken(user.id);
    expect(marketingToken.split('.')).toHaveLength(2);
    const marketing = await unsubscribe(marketingToken);
    expect(marketing.status).toBe(200);
    expect(marketing.body).toEqual({ unsubscribedFrom: 'MARKETING' });
    expect(await prefs()).toEqual({
      marketingEmail: false,
      marketingSms: false,
      unreadMessageSms: true,
      unreadMessageEmail: false,
    });
  });

  it('refuses a link that was changed', async () => {
    const user = await createUser();
    const other = await createUser({ email: 'tama@example.co.nz' });
    const [id, , signature] = unsubscribeToken(user.id, 'MESSAGE_EMAILS').split('.');
    const marketingSignature = unsubscribeToken(user.id).split('.')[1];
    const flip = (text: string) => `${text.slice(0, -1)}${text.endsWith('A') ? 'B' : 'A'}`;

    for (const token of [
      `${id}.${flip(signature!)}`.replace(`${id}.`, `${id}.MESSAGE_EMAILS.`),
      `${id}.MARKETING.${signature}`,
      `${id}.MESSAGE_EMAILS.${marketingSignature}`,
      `${id}.${signature}`,
      `${other.id}.MESSAGE_EMAILS.${signature}`,
      `${id}.EVERYTHING.${signature}`,
      `${id}.MESSAGE_EMAILS.${signature}.extra`,
      `${id}.MESSAGE_EMAILS.`,
      // Reshuffled so the scoped signature reads as a marketing one for an "id" that isn't one.
      `${id}:MESSAGE_EMAILS.${signature}`,
    ]) {
      const response = await browserAgent().post('/api/v1/notifications/unsubscribe').send({ token });
      expect(response.status, token).toBe(400);
      expect(response.body.error.code, token).toBe('INVALID_LINK');
    }
    const prefs = (await UserModel.findById(user._id).lean())!.notificationPrefs;
    expect(prefs.unreadMessageEmail).toBe(true);
  });

  // A signature of the right length in characters but not in bytes is refused, not a server error.
  it('refuses a changed link with characters outside ASCII', async () => {
    const user = await createUser();
    const signature = unsubscribeToken(user.id).split('.')[1]!;
    const response = await browserAgent()
      .post('/api/v1/notifications/unsubscribe')
      .send({ token: `${user.id}.${'é'.repeat(signature.length)}` });
    expect(response.status).toBe(400);
  });

  it('works as an email app’s one-click unsubscribe: a form post to the header’s link, with no Origin', async () => {
    const user = await createUser();
    const link = new URL(oneClickUnsubscribeUrl(user.id, 'MESSAGE_EMAILS'));
    expect(link.origin).toBe('http://localhost:4000');

    const response = await request(testApp())
      .post(`${link.pathname}${link.search}`)
      .type('form')
      .send('List-Unsubscribe=One-Click');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ unsubscribedFrom: 'MESSAGE_EMAILS' });
    expect((await UserModel.findById(user._id).lean())!.notificationPrefs.unreadMessageEmail).toBe(false);
  });

  /** Kiri messages Hana about their booking: the unread-message job for Hana. */
  async function unreadForHost() {
    const { host, booking } = await trip();
    const guestAgent = await signIn('kiri@example.co.nz');
    await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'Is 10 am OK?' });
    const job = await JobModel.findOne({ type: 'messages.unreadEmail' }).lean();
    return { host, booking, payload: job!.payload as { threadId: string; recipientId: string } };
  }

  it('emails an unread message with a one-click unsubscribe link and one in the email', async () => {
    const { host, payload } = await unreadForHost();
    await unreadMessageEmailJob(payload, context);

    const sent = await byChannel(host._id, 'NEW_MESSAGE');
    expect(Object.keys(sent).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(sent.EMAIL!.payload).toMatchObject({
      template: 'newMessage',
      props: { firstName: 'Hana', unsubscribeUrl: unsubscribeUrl(host.id, 'MESSAGE_EMAILS') },
      listUnsubscribe: oneClickUnsubscribeUrl(host.id, 'MESSAGE_EMAILS'),
    });
    expect((sent.EMAIL!.payload as { listUnsubscribe: string }).listUnsubscribe).toMatch(
      /^http:\/\/localhost:4000\/api\/v1\/notifications\/unsubscribe\?token=/,
    );
  });

  it('only notifies in the app once unread-message emails are turned off', async () => {
    const { host, payload } = await unreadForHost();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'notificationPrefs.unreadMessageEmail': false } });
    await unreadMessageEmailJob(payload, context);

    expect(Object.keys(await byChannel(host._id, 'NEW_MESSAGE'))).toEqual(['IN_APP']);
    expect(await JobModel.countDocuments({ type: 'notification.send' })).toBe(0);
  });
});

describe('a member’s public profile', () => {
  it('is open to visitors, while blocking still needs signing in', async () => {
    const host = await createHost();
    const visitor = request(testApp());

    const profile = await visitor.get(`/api/v1/users/${host.id}/reviews`);
    expect(profile.status).toBe(200);
    expect(profile.body.profile).toMatchObject({ id: host.id, firstName: 'Hana' });
    expect(JSON.stringify(profile.body)).not.toContain('example.co.nz');

    expect((await visitor.post(`/api/v1/users/${host.id}/block`)).status).toBe(401);
    expect((await visitor.delete(`/api/v1/users/${host.id}/block`)).status).toBe(401);
    expect((await browserAgent().post(`/api/v1/users/${host.id}/block`)).status).toBe(401);
  });
});

describe('suspending a car', () => {
  it('links the Host’s notice and email to the car’s page', async () => {
    const { host, vehicle } = await trip();
    await createStaff();
    const staff = await staffAgent();

    const suspended = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/suspend`)
      .send({ reason: 'Rego plate does not match' });
    expect(suspended.status).toBe(200);
    const sent = await byChannel(host._id, 'VEHICLE_SUSPENDED');
    expect(sent.IN_APP!.payload).toMatchObject({ link: `/host/vehicles/${vehicle.id}` });
    expect(sent.EMAIL!.payload).toMatchObject({
      template: 'tripNotice',
      props: { buttonLabel: 'View your car', url: `http://localhost:5173/host/vehicles/${vehicle.id}` },
    });
  });
});

describe('listing changes reviewed by staff', () => {
  /** A Host's car with a new photo and a new document waiting for staff. */
  async function carWithChanges(status: 'ACTIVE' | 'UNDER_REVIEW' = 'ACTIVE') {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, { status });
    await VehicleModel.updateOne(
      { _id: vehicle._id },
      {
        $push: {
          photos: { type: 'BOOT', url: 'https://img.example.com/new/boot.jpg', order: 3, status: 'PENDING' },
          documents: {
            type: 'WOF',
            url: 'local:vehicles/x/wof.pdf',
            expiry: new Date(Date.now() + 300 * DAY_MS),
            status: 'PENDING',
          },
        },
      },
    );
    const fresh = (await VehicleModel.findById(vehicle._id).lean())!;
    await createStaff();
    return {
      host,
      vehicle,
      photoId: fresh.photos.find((photo) => photo.status === 'PENDING')!._id!.toString(),
      documentId: fresh.documents[0]!._id!.toString(),
      staff: await staffAgent(),
    };
  }

  it('emails the Host a rejected photo or document', async () => {
    const { host, vehicle, photoId, documentId, staff } = await carWithChanges();

    const photo = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/photos/${photoId}`)
      .send({ decision: 'REJECT' });
    expect(photo.status).toBe(200);
    const photoNotice = await byChannel(host._id, 'LISTING_PHOTO_REJECTED');
    expect(Object.keys(photoNotice).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(photoNotice.EMAIL!.payload).toMatchObject({
      template: 'tripNotice',
      props: {
        firstName: 'Hana',
        heading: 'Please retake the boot photo of your 2021 Toyota Corolla',
        url: `http://localhost:5173/host/vehicles/${vehicle.id}/3`,
      },
    });

    const document = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/documents/${documentId}`)
      .send({ decision: 'REJECT' });
    expect(document.status).toBe(200);
    const documentNotice = await byChannel(host._id, 'LISTING_DOCUMENT_REJECTED');
    expect(Object.keys(documentNotice).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(documentNotice.EMAIL!.payload).toMatchObject({
      template: 'tripNotice',
      props: {
        heading: 'Please upload the WOF for your 2021 Toyota Corolla again',
        url: `http://localhost:5173/host/vehicles/${vehicle.id}/2`,
      },
    });
    expect(await NotificationModel.countDocuments({ type: 'LISTING_CHANGES_APPROVED' })).toBe(0);
  });

  it('emails one approval a day for a live car’s new photo and document, approved one at a time', async () => {
    const { host, vehicle, photoId, documentId, staff } = await carWithChanges();

    expect(
      (
        await staff
          .post(`/api/v1/admin/vehicles/${vehicle.id}/photos/${photoId}`)
          .send({ decision: 'APPROVE' })
      ).status,
    ).toBe(200);
    const approved = await byChannel(host._id, 'LISTING_CHANGES_APPROVED');
    expect(Object.keys(approved).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(approved.IN_APP!.payload).toMatchObject({
      title: 'Your changes to the 2021 Toyota Corolla are approved',
      body: 'We approved the boot photo.',
      link: `/host/vehicles/${vehicle.id}`,
    });
    expect(approved.EMAIL!.payload).toMatchObject({
      template: 'tripNotice',
      props: { firstName: 'Hana', url: `http://localhost:5173/host/vehicles/${vehicle.id}` },
    });

    // The document the same day: no second email.
    expect(
      (
        await staff
          .post(`/api/v1/admin/vehicles/${vehicle.id}/documents/${documentId}`)
          .send({ decision: 'VERIFY' })
      ).status,
    ).toBe(200);
    expect(
      await NotificationModel.countDocuments({ type: 'LISTING_CHANGES_APPROVED', channel: 'IN_APP' }),
    ).toBe(1);
    expect(
      await NotificationModel.countDocuments({ type: 'LISTING_CHANGES_APPROVED', channel: 'EMAIL' }),
    ).toBe(1);
  });

  it('emails one approval for everything approved with the listing', async () => {
    const { host, vehicle, staff } = await carWithChanges();

    const approved = await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/approve`).send({});
    expect(approved.status).toBe(200);
    const sent = await byChannel(host._id, 'LISTING_CHANGES_APPROVED');
    expect(Object.keys(sent).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(sent.IN_APP!.payload).toMatchObject({ body: 'We approved the boot photo and the WOF.' });
    expect(await NotificationModel.countDocuments({ type: 'LISTING_APPROVED' })).toBe(0);

    // Nothing new to approve: nothing sent.
    await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/approve`).send({});
    expect(await NotificationModel.countDocuments({ type: 'LISTING_CHANGES_APPROVED' })).toBe(2);
  });

  it('sends only the listing decision when a listing is approved for the first time', async () => {
    const { host, vehicle, staff } = await carWithChanges('UNDER_REVIEW');

    const approved = await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(await NotificationModel.countDocuments({ type: 'LISTING_CHANGES_APPROVED' })).toBe(0);
    const decision = await byChannel(host._id, 'LISTING_APPROVED');
    expect(Object.keys(decision).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(decision.EMAIL!.payload).toMatchObject({
      template: 'listingDecision',
      props: { decision: 'APPROVED' },
    });
  });

  // Only PENDING photos and documents are changes: re-approving one already approved tells nobody.
  it('sends nothing for re-approving a photo that was already approved', async () => {
    const { host, vehicle, staff } = await carWithChanges();
    const approvedPhoto = vehicle.photos[0]!._id!.toString();

    await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/photos/${approvedPhoto}`)
      .send({ decision: 'APPROVE' });
    expect(
      await NotificationModel.countDocuments({ userId: host._id, type: 'LISTING_CHANGES_APPROVED' }),
    ).toBe(0);
  });
});

// Last: startRealtime() leaves the app's Socket.IO server set for the rest of the file.
describe('live connections', () => {
  const sockets: ClientSocket[] = [];

  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.close());
  });

  it('closes a suspended account’s open tabs at once', async () => {
    const http = createServer();
    const io = await startRealtime(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const guest = await createUser();
      const signedIn = await login({ email: 'kiri@example.co.nz', password: PASSWORD, portal: 'app' }, {});
      if (!('tokens' in signedIn)) throw new Error('Expected a session');
      const socket = connectClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        extraHeaders: { Origin: FRONTEND_ORIGIN, Cookie: `rv_access=${signedIn.tokens.accessToken}` },
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      await expect
        .poll(() =>
          io.local
            .in(userRoom(guest.id))
            .fetchSockets()
            .then((found) => found.length),
        )
        .toBe(1);

      const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
      await createStaff();
      const staff = await staffAgent();
      expect(
        (await staff.post(`/api/v1/admin/users/${guest.id}/suspend`).send({ reason: 'Fraudulent payments' }))
          .status,
      ).toBe(200);
      expect(await disconnected).toBe('io server disconnect');
    } finally {
      await io.close();
    }
  });
});
