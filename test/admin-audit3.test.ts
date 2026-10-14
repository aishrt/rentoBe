import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { addNzDays, nzDate, nzDayStart } from '../src/lib/nz-time.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { reportRange } from '../src/modules/admin/admin-reports.service.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { ReportModel } from '../src/modules/moderation/report.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PaymentModel } from '../src/modules/payments/payment.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * The staff portal's third audit (plan §6.2, §8.1, §8.2, §14; spec §18): support staff never decide their own
 * records, a car its Host switched off stays off after a key-detail review, searches find full names and NZ
 * mobiles, NZ day ranges hold across daylight saving, failed payments include declined cards, and the
 * smaller state checks, paging and exports.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => nzDate(new Date());
const daysFromToday = (days: number) => nzDate(addNzDays(nzDayStart(today()), days));

/** A risk flag's id: flags are subdocuments, with ids the User type doesn't declare. */
const flagIdOf = (flag: unknown) => (flag as { _id: mongoose.Types.ObjectId })._id.toString();

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

describe('support staff and their own records', () => {
  /** Sam is on the support team and also a Guest and a Host, with a car, a trip on Hana's and one on his. */
  async function samTheHost() {
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    await UserModel.updateOne(
      { _id: sam._id },
      {
        $set: {
          roles: ['GUEST', 'HOST', 'SUPPORT'],
          permissions: ['REFUNDS'],
          hostProfile: {
            status: 'APPROVED',
            appliedAt: new Date(),
            payoutsEnabled: true,
            tripCount: 0,
            rating: { avg: 0, count: 0 },
            feesOwedCents: 0,
            gstRegistered: false,
          },
          identityVerification: { status: 'PENDING' },
          driverLicence: { class: 'NZ_FULL', country: 'NZ', numberEnding: '456', status: 'PENDING' },
          riskFlags: [{ code: 'BOOKING_VELOCITY', createdAt: new Date() }],
        },
      },
    );
    const samsCar = await createVehicle(sam._id);
    await VehicleModel.updateOne({ _id: samsCar._id }, { $set: { 'photos.0.status': 'PENDING' } });
    const hana = await createHost();
    const hanasCar = await createVehicle(hana._id);
    const asGuest = await createBookingRecord({
      guestId: sam._id,
      hostId: hana._id,
      vehicleId: hanasCar._id,
    });
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const asHost = await createBookingRecord({ guestId: guest._id, hostId: sam._id, vehicleId: samsCar._id });
    await createPaymentRecord(asHost);
    return { sam: (await UserModel.findById(sam._id).lean())!, samsCar, asGuest, asHost };
  }

  it('leaves each of them to another team member, while the admin can act on their own', async () => {
    const { sam, samsCar, asGuest, asHost } = await samTheHost();
    const agent = await staffAgent('sam@example.co.nz');
    const flagId = flagIdOf(sam.riskFlags[0]);
    const photoId = (await VehicleModel.findById(samsCar._id).lean())!.photos[0]!._id!.toString();
    const attempts = [
      () => agent.post(`/api/v1/admin/users/${sam._id}/identity-review`).send({ decision: 'APPROVE' }),
      () => agent.post(`/api/v1/admin/users/${sam._id}/licence-review`).send({ decision: 'APPROVE' }),
      () => agent.post(`/api/v1/admin/host-applications/${sam._id}/approve`).send({}),
      () => agent.post(`/api/v1/admin/users/${sam._id}/risk-flags/${flagId}/clear`),
      () => agent.post(`/api/v1/admin/vehicles/${samsCar.id}/approve`).send({}),
      () =>
        agent.post(`/api/v1/admin/vehicles/${samsCar.id}/photos/${photoId}`).send({ decision: 'APPROVE' }),
      () =>
        agent
          .post(`/api/v1/admin/vehicles/${samsCar.id}/documents/${new mongoose.Types.ObjectId().toString()}`)
          .send({ decision: 'VERIFY' }),
      () => agent.post(`/api/v1/admin/vehicles/${samsCar.id}/suspend`).send({ reason: 'Checking it over' }),
      // The calendar override, which could lift a staff block on his own car.
      () =>
        agent
          .post(`/api/v1/admin/vehicles/${samsCar.id}/blocks`)
          .send({ start: daysFromToday(20), end: daysFromToday(22) }),
      () =>
        agent.delete(
          `/api/v1/admin/vehicles/${samsCar.id}/blocks/${new mongoose.Types.ObjectId().toString()}`,
        ),
      // Correcting his own details, or downloading them, on a privacy request.
      () => agent.patch(`/api/v1/admin/users/${sam._id}`).send({ lastName: 'Smith', reason: 'Spelling' }),
      () => agent.get(`/api/v1/admin/users/${sam._id}/export`),
      () =>
        agent
          .post(`/api/v1/admin/bookings/${asGuest.ref}/status`)
          .send({ to: 'ACTIVE', reason: 'Picked up' }),
      () =>
        agent
          .post(`/api/v1/admin/bookings/${asGuest.ref}/cancel`)
          .send({ reason: 'PLATFORM', note: 'Testing' }),
      () =>
        agent
          .post(`/api/v1/admin/bookings/${asHost.ref}/complete`)
          .send({ odometer: 45210, fuelOrBatteryPct: 80 }),
      () =>
        agent
          .post(`/api/v1/admin/bookings/${asHost.ref}/refunds`)
          .send({ amountCents: 1000, reason: 'Goodwill', fundedBy: 'PLATFORM' }),
    ];
    // One at a time: supertest starts each when it's awaited.
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.error).toEqual({
        code: 'OWN_RECORD',
        message: "Another team member needs to handle this, as it's about your own account.",
      });
    }
    // The cancel dialog says so before they try.
    const preview = await agent
      .get(`/api/v1/admin/bookings/${asGuest.ref}/cancellation-preview`)
      .query({ reason: 'PLATFORM' });
    expect(preview.body).toMatchObject({
      allowed: false,
      message: "Another team member needs to handle this, as it's about your own account.",
    });
    // Nothing changed.
    const after = (await UserModel.findById(sam._id).lean())!;
    expect(after.identityVerification?.status).toBe('PENDING');
    expect(after.driverLicence?.status).toBe('PENDING');
    expect(after.riskFlags[0]!.clearedAt).toBeUndefined();
    expect((await VehicleModel.findById(samsCar._id).lean())!.status).toBe('ACTIVE');
    expect(await PaymentModel.countDocuments({ 'refunds.0': mongoose.trusted({ $exists: true }) })).toBe(0);

    // Another team member, here the admin, can; and the admin can act on their own record.
    const admin = await staffAgent();
    expect((await admin.post(`/api/v1/admin/users/${sam._id}/risk-flags/${flagId}/clear`)).status).toBe(200);
    const aroha = await UserModel.findOneAndUpdate(
      { email: 'aroha@example.co.nz' },
      { $set: { riskFlags: [{ code: 'CARD_COUNTRY', createdAt: new Date() }] } },
      { new: true },
    ).lean();
    const own = await admin.post(
      `/api/v1/admin/users/${aroha!._id}/risk-flags/${flagIdOf(aroha!.riskFlags[0])}/clear`,
    );
    expect(own.status).toBe(200);
    expect(await AuditLogModel.countDocuments({ action: 'risk-flag.cleared', actorId: aroha!._id })).toBe(2);
  });

  it('covers cases, reviews, reports, support requests and messages about them too', async () => {
    const { sam, asGuest, asHost } = await samTheHost();
    const agent = await staffAgent('sam@example.co.nz');
    const hanaId = asGuest.hostId;
    const incident = await IncidentModel.create({
      caseRef: 'IN-SAM001',
      bookingId: asGuest._id,
      reporterId: hanaId,
      type: 'DAMAGE',
      description: 'A scratch on the bumper',
      events: [{ actorId: hanaId, action: 'OPENED', visibility: 'BOTH', createdAt: new Date() }],
    });
    const review = await ReviewModel.create({
      bookingId: asGuest._id,
      authorId: hanaId,
      subjectId: sam._id,
      direction: 'HOST_TO_GUEST',
      overall: 2,
      body: 'Returned it late',
    });
    const report = await ReportModel.create({
      reporterId: hanaId,
      targetType: 'USER',
      targetId: sam._id,
      subjectUserId: sam._id,
      reason: 'Rude in messages',
    });
    const ticket = await SupportTicketModel.create({
      ref: 'ST-SAM001',
      userId: sam._id,
      subject: 'My payout',
      messages: [{ authorId: sam._id, body: 'Where is it?' }],
    });
    // A Guest of Sam's asks support about the trip on his car.
    const aboutHisCar = await SupportTicketModel.create({
      ref: 'ST-SAM002',
      userId: asHost.guestId,
      bookingId: asHost._id,
      subject: 'The host was late',
      messages: [{ authorId: asHost.guestId, body: 'He kept me waiting an hour' }],
    });
    const thread = await ThreadModel.create({
      bookingId: asHost._id,
      participantIds: [asHost.guestId, sam._id],
    });
    const message = await MessageModel.create({ threadId: thread._id, senderId: asHost.guestId, body: 'Hi' });
    await ReportModel.create({
      reporterId: sam._id,
      targetType: 'MESSAGE',
      targetId: message._id,
      subjectUserId: asHost.guestId,
      reason: 'Spam',
    });

    const attempts = [
      () =>
        agent.post(`/api/v1/admin/incidents/${incident.caseRef}/events`).send({ note: 'Looking into it' }),
      () =>
        agent
          .post(`/api/v1/admin/incidents/${incident.caseRef}/assignee`)
          .send({ userId: sam._id.toString() }),
      () =>
        agent.post('/api/v1/admin/incidents').send({
          bookingRef: asHost.ref,
          type: 'OTHER',
          description: 'Opened by support',
          visibility: 'INTERNAL',
        }),
      () =>
        agent.post(`/api/v1/admin/reviews/${review.id}/moderate`).send({ action: 'HIDE', reason: 'Unfair' }),
      () =>
        agent
          .post(`/api/v1/admin/moderation/reports/${report.id}/resolve`)
          .send({ status: 'DISMISSED', resolution: 'Nothing to see' }),
      () => agent.post(`/api/v1/admin/support/tickets/${ticket.ref}/messages`).send({ body: 'Sorted' }),
      () => agent.patch(`/api/v1/admin/support/tickets/${ticket.ref}`).send({ status: 'RESOLVED' }),
      () => agent.post(`/api/v1/admin/support/tickets/${aboutHisCar.ref}/messages`).send({ body: 'Sorted' }),
      () => agent.patch(`/api/v1/admin/support/tickets/${aboutHisCar.ref}`).send({ status: 'RESOLVED' }),
      () => agent.post(`/api/v1/admin/moderation/messages/${message.id}/remove`).send({ reason: 'Spam' }),
    ];
    // One at a time: supertest starts each when it's awaited.
    for (const attempt of attempts) {
      const response = await attempt();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('OWN_RECORD');
    }
    expect((await ReviewModel.findById(review._id).lean())!.status).not.toBe('HIDDEN');
    expect((await ReportModel.findById(report._id).lean())!.status).toBe('OPEN');
    expect((await SupportTicketModel.findById(ticket._id).lean())!.messages).toHaveLength(1);
    expect((await MessageModel.findById(message._id).lean())!.hiddenAt).toBeUndefined();
    expect(await IncidentModel.countDocuments()).toBe(1);

    // The admin can, but can't hand Sam a case about his own trip: he couldn't act on it.
    const admin = await staffAgent();
    const handed = await admin
      .post(`/api/v1/admin/incidents/${incident.caseRef}/assignee`)
      .send({ userId: sam._id.toString() });
    expect(handed.status).toBe(409);
    expect(handed.body.error.code).toBe('OWN_RECORD');
    expect(
      (await admin.post(`/api/v1/admin/support/tickets/${ticket.ref}/messages`).send({ body: 'Sorted' }))
        .status,
    ).toBe(200);
  });
});

describe('a key-detail change on a car its Host switched off', () => {
  it('stays off once approved, and the Host hears the changes were approved rather than that it is live', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, { status: 'INACTIVE', regoPlate: 'ABC123' });
    const hostAgent = await signIn('hana@example.co.nz');
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const staff = await staffAgent('sam@example.co.nz');

    const edited = await hostAgent
      .patch(`/api/v1/host/vehicles/${vehicle.id}`)
      .send({ regoPlate: 'XYZ 789' });
    expect(edited.body.vehicle.status).toBe('UNDER_REVIEW');
    expect((await VehicleModel.findById(vehicle._id).lean())!.keyReviewFrom).toBe('INACTIVE');

    // Sent back for changes, it keeps where it came from for the next look.
    const changes = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/request-changes`)
      .send({ notes: 'Please upload the new registration papers.' });
    expect(changes.body.vehicle.status).toBe('CHANGES_REQUESTED');
    expect((await VehicleModel.findById(vehicle._id).lean())!.keyReviewFrom).toBe('INACTIVE');
    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { status: 'UNDER_REVIEW' } });

    const approved = await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.vehicle.status).toBe('INACTIVE');
    const stored = (await VehicleModel.findById(vehicle._id).lean())!;
    expect(stored.keyReviewFrom).toBeUndefined();
    expect(stored.keyChanges).toBeUndefined();
    expect(await NotificationModel.countDocuments({ userId: host._id, type: 'LISTING_APPROVED' })).toBe(0);
    const told = await NotificationModel.findOne({
      userId: host._id,
      type: 'LISTING_CHANGES_APPROVED',
      channel: 'EMAIL',
    }).lean();
    expect(JSON.stringify(told!.payload)).toContain('the new number plate');
    expect(JSON.stringify(told!.payload)).toContain('It stays switched off');
  });

  it('goes back live when it was on, and a rejection forgets where it came from', async () => {
    const host = await createHost();
    const live = await createVehicle(host._id);
    const other = await createVehicle(host._id, { status: 'INACTIVE' });
    const hostAgent = await signIn('hana@example.co.nz');
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const staff = await staffAgent('sam@example.co.nz');

    await hostAgent.patch(`/api/v1/host/vehicles/${live.id}`).send({ year: 2022 });
    expect((await staff.post(`/api/v1/admin/vehicles/${live.id}/approve`).send({})).body.vehicle.status).toBe(
      'ACTIVE',
    );

    await hostAgent.patch(`/api/v1/host/vehicles/${other.id}`).send({ make: 'Honda' });
    const rejected = await staff
      .post(`/api/v1/admin/vehicles/${other.id}/reject`)
      .send({ notes: 'That isn’t the car in the photos.' });
    expect(rejected.body.vehicle.status).toBe('REJECTED');
    expect((await VehicleModel.findById(other._id).lean())!.keyReviewFrom).toBeUndefined();
  });
});

describe('staff searches', () => {
  it('find a person by full name or an NZ mobile as typed, and their bookings by name', async () => {
    await createStaff();
    const admin = await staffAgent();
    const jane = await createUser({ email: 'jane@example.co.nz', firstName: 'Jane' });
    await UserModel.updateOne({ _id: jane._id }, { $set: { lastName: 'Smith', phone: '+64211234567' } });
    await createUser({ email: 'jane.brown@example.co.nz', firstName: 'Jane' });
    const found = async (q: string) =>
      (await admin.get('/api/v1/admin/users').query({ q })).body.users.map(
        (user: { email: string }) => user.email,
      );

    expect(await found('Jane Smith')).toEqual(['jane@example.co.nz']);
    expect(await found('smith jane')).toEqual(['jane@example.co.nz']);
    expect(await found('Jane')).toHaveLength(2);
    expect(await found('Jane Brown')).toEqual(['jane.brown@example.co.nz']);
    expect(await found('Jane Walker')).toEqual([]);
    for (const mobile of ['021 123 4567', '0211234567', '+64 21 123 4567', '1234567']) {
      expect(await found(mobile)).toEqual(['jane@example.co.nz']);
    }

    const host = await createHost();
    const car = await createVehicle(host._id);
    const booking = await createBookingRecord({ guestId: jane._id, hostId: host._id, vehicleId: car._id });
    const bookings = async (q: string) =>
      (await admin.get('/api/v1/admin/bookings').query({ q })).body.bookings.map(
        (row: { ref: string }) => row.ref,
      );
    expect(await bookings('Jane Smith')).toEqual([booking.ref]);
    expect(await bookings('021 123 4567')).toEqual([booking.ref]);
    expect(await bookings('Toyota Corolla')).toEqual([booking.ref]);
    expect(await bookings('Jane Doe')).toEqual([]);
  });
});

describe('NZ day ranges across daylight saving', () => {
  it('end at the midnight starting the next day, 23 or 25 hours after the start', () => {
    // Daylight saving starts on 27 September 2026 and ends on 4 April 2027.
    expect(reportRange('2026-09-27', '2026-09-27')).toMatchObject({
      start: new Date('2026-09-26T12:00:00Z'),
      end: new Date('2026-09-27T11:00:00Z'),
    });
    expect(reportRange('2027-04-04', '2027-04-04')).toMatchObject({
      start: new Date('2027-04-03T11:00:00Z'),
      end: new Date('2027-04-04T12:00:00Z'),
    });
    // A year and a bit, counted in calendar days.
    expect(() => reportRange('2026-01-01', '2027-02-04')).not.toThrow();
    expect(() => reportRange('2026-01-01', '2027-02-05')).toThrow(/up to 400 days/);
  });

  it('count a trip on the NZ day it starts, in the reports and the booking search', async () => {
    await createStaff();
    const admin = await staffAgent();
    const host = await createHost();
    const guest = await createUser();
    const car = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: car._id };
    // 12:30 am on the first day of daylight saving's first full day, and 11:30 pm on the day it ends.
    const afterSpring = await createBookingRecord(parties, { startAt: new Date('2026-09-27T11:30:00Z') });
    const lateAutumn = await createBookingRecord(parties, { startAt: new Date('2027-04-04T11:30:00Z') });

    const trips = async (from: string, to: string) =>
      (await admin.get('/api/v1/admin/reports/summary').query({ from, to })).body.report.money
        .grossBookingsCents;
    expect(await trips('2026-09-27', '2026-09-27')).toBe(0);
    expect(await trips('2026-09-28', '2026-09-28')).toBe(33870);
    expect(await trips('2027-04-04', '2027-04-04')).toBe(33870);
    expect(await trips('2027-04-05', '2027-04-05')).toBe(0);

    const refs = async (from: string, to: string) =>
      (await admin.get('/api/v1/admin/bookings').query({ from, to })).body.bookings.map(
        (row: { ref: string }) => row.ref,
      );
    expect(await refs('2026-09-01', '2026-09-27')).toEqual([]);
    expect(await refs('2026-09-28', '2026-09-28')).toEqual([afterSpring.ref]);
    expect(await refs('2027-04-04', '2027-04-04')).toEqual([lateAutumn.ref]);

    // The overview's default range is 30 NZ days, not 31 across the change.
    expect((await admin.get('/api/v1/admin/dashboard').query({ to: '2026-10-12' })).body.from).toBe(
      '2026-09-13',
    );
  });
});

describe('money in the overview and reports', () => {
  it('shows the overview’s booking revenue on the report, and counts declined cards as failed payments', async () => {
    await createStaff();
    const admin = await staffAgent();
    const host = await createHost();
    const guest = await createUser();
    const car = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: car._id };
    const booking = await createBookingRecord(parties, { startAt: new Date(Date.now() + DAY_MS) });
    await createPaymentRecord(booking);
    const declined = { failureReason: 'Your card was declined.' };
    const pending = await createPaymentRecord(booking, { status: 'PENDING', ...declined });
    await createPaymentRecord(booking, { status: 'CANCELLED', ...declined });
    await createPaymentRecord(booking, { type: 'EXTRA_CHARGE', status: 'FAILED', ...declined });
    const old = await createPaymentRecord(booking, { status: 'CANCELLED', ...declined });
    await PaymentModel.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date(Date.now() - 40 * DAY_MS) } },
    );

    const range = { from: today(), to: daysFromToday(5) };
    const { report } = (await admin.get('/api/v1/admin/reports/summary').query(range)).body;
    const dashboard = (await admin.get('/api/v1/admin/dashboard').query(range)).body;
    expect(report.money.bookingRevenueCents).toBe(33870);
    expect(dashboard.figures.bookingRevenueCents).toBe(report.money.bookingRevenueCents);

    const failed = await admin.get('/api/v1/admin/payments').query({ view: 'failed' });
    expect(failed.body.total).toBe(4);
    expect(failed.body.payments.map((payment: { status: string }) => payment.status).sort()).toEqual([
      'CANCELLED',
      'CANCELLED',
      'FAILED',
      'PENDING',
    ]);
    expect(failed.body.payments.find((payment: { id: string }) => payment.id === pending.id)).toMatchObject({
      status: 'PENDING',
      failureReason: 'Your card was declined.',
    });
    // The overview counts the last 30 NZ days, as its link lists them.
    expect(dashboard.queues.failedPayments).toBe(3);
    const recent = await admin
      .get('/api/v1/admin/payments')
      .query({ view: 'failed', from: daysFromToday(-29) });
    expect(recent.body.total).toBe(3);
  });

  it('exports CSVs Excel reads as UTF-8', async () => {
    await createStaff();
    const admin = await staffAgent();
    const csv = await admin
      .get('/api/v1/admin/reports/export')
      .query({ type: 'gst', from: today(), to: today() })
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect([...(csv.body as Buffer).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect((csv.body as Buffer).subarray(3).toString('utf8')).toMatch(/^Month,/);
  });
});

describe('state checks', () => {
  async function applicant(email: string, status: 'APPLIED' | 'APPROVED' | 'REJECTED') {
    const user = await createUser({ email, roles: ['GUEST', 'HOST'] });
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          emailVerifiedAt: new Date(),
          identityVerification: { status: 'APPROVED' },
          hostProfile: {
            status,
            appliedAt: new Date(),
            payoutsEnabled: false,
            tripCount: 0,
            rating: { avg: 0, count: 0 },
            feesOwedCents: 0,
            gstRegistered: false,
          },
        },
      },
    );
    return user;
  }

  it('rejects only a Host application waiting for a decision, and approves it then or after a rejection', async () => {
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const staff = await staffAgent('sam@example.co.nz');
    const approved = await applicant('hana@example.co.nz', 'APPROVED');
    const rejected = await applicant('tama@example.co.nz', 'REJECTED');
    const decide = (id: string, action: 'approve' | 'reject') =>
      staff.post(`/api/v1/admin/host-applications/${id}/${action}`).send({ notes: 'Checked the details.' });

    const reject = await decide(approved.id, 'reject');
    expect(reject.status).toBe(409);
    expect(reject.body.error.code).toBe('NOT_APPLIED');
    expect(reject.body.error.message).toMatch(/suspend their account or their cars/);
    expect((await decide(approved.id, 'approve')).status).toBe(409);
    expect((await decide(rejected.id, 'reject')).status).toBe(409);
    expect((await decide(rejected.id, 'approve')).body.status).toBe('APPROVED');
    expect((await UserModel.findById(approved._id).lean())!.hostProfile!.status).toBe('APPROVED');
  });

  it('keeps a closed account suspended', async () => {
    await createStaff();
    const admin = await staffAgent();
    const closed = await createUser({ email: 'former@example.co.nz', status: 'SUSPENDED' });
    await UserModel.updateOne({ _id: closed._id }, { $set: { closedAt: new Date() } });

    const response = await admin.post(`/api/v1/admin/users/${closed.id}/unsuspend`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ACCOUNT_CLOSED');
    expect((await UserModel.findById(closed._id).lean())!.status).toBe('SUSPENDED');
  });
});

describe('paging', () => {
  it('pages Host applications, waiting ones oldest first and decided ones newest first', async () => {
    await createStaff();
    const admin = await staffAgent();
    const start = Date.now() - 100 * DAY_MS;
    for (let index = 0; index < 27; index += 1) {
      const user = await createUser({ email: `applicant${index}@example.co.nz`, roles: ['GUEST', 'HOST'] });
      await UserModel.updateOne(
        { _id: user._id },
        {
          $set: {
            hostProfile: {
              status: index < 25 ? 'APPLIED' : 'APPROVED',
              appliedAt: new Date(start + index * DAY_MS),
              payoutsEnabled: false,
              tripCount: 0,
              rating: { avg: 0, count: 0 },
              feesOwedCents: 0,
              gstRegistered: false,
            },
          },
        },
      );
    }
    const first = (await admin.get('/api/v1/admin/host-applications')).body;
    expect(first).toMatchObject({ total: 25, page: 1 });
    expect(first.applications).toHaveLength(25);
    expect(first.applications[0].email).toBe('applicant0@example.co.nz');
    const second = (await admin.get('/api/v1/admin/host-applications').query({ page: 2 })).body;
    expect(second.applications).toEqual([]);

    const decided = (await admin.get('/api/v1/admin/host-applications').query({ status: 'APPROVED' })).body;
    expect(decided.applications.map((row: { email: string }) => row.email)).toEqual([
      'applicant26@example.co.nz',
      'applicant25@example.co.nz',
    ]);
    expect((await admin.get('/api/v1/admin/host-applications').query({ page: 501 })).status).toBe(400);
  });

  it('reaches older audit entries by NZ dates', async () => {
    await createStaff();
    const admin = await staffAgent();
    await AuditLogModel.collection.insertMany([
      { action: 'test.old', entity: 'user', createdAt: new Date('2025-03-01T00:00:00Z') },
      { action: 'test.older', entity: 'user', createdAt: new Date('2024-06-15T00:00:00Z') },
    ]);
    const entries = async (query: Record<string, string>) =>
      (await admin.get('/api/v1/admin/audit').query(query)).body.entries.map(
        (entry: { action: string }) => entry.action,
      );
    expect(await entries({ from: '2025-01-01', to: '2025-12-31' })).toEqual(['test.old']);
    expect(await entries({ to: '2024-12-31' })).toEqual(['test.older']);
    expect(await entries({ from: '2024-06-15', to: '2024-06-15' })).toEqual(['test.older']);
  });
});
