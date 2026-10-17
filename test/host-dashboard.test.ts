import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { formatNzDateTime } from '../src/lib/format.js';
import { runHostReminders } from '../src/modules/hosts/host-reminders.service.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

describe('the Host’s to-do list', () => {
  it('lists payout setup, requests, check-ins and documents expiring, urgent first', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id, { wofExpiry: new Date(Date.now() + 5 * DAY_MS) });
    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { payoutsReady: false } });
    const requestExpiresAt = new Date(Date.now() + DAY_MS);
    await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'PENDING', instantBook: false, requestExpiresAt },
    );
    await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { startAt: new Date(Date.now() + 2 * 60 * 60 * 1000), endAt: new Date(Date.now() + 3 * DAY_MS) },
    );

    const agent = await signIn(host.email);
    const { items } = (await agent.get('/api/v1/host/todo')).body;
    expect(items.map((item: { kind: string }) => item.kind).sort()).toEqual(
      ['CHECK_IN', 'DOCUMENT_EXPIRING', 'PAYOUT_SETUP', 'REQUESTS'].sort(),
    );
    expect(items.find((item: { kind: string }) => item.kind === 'PAYOUT_SETUP')).toMatchObject({
      urgent: true,
      detail: 'An approved listing goes live once it’s done.',
    });
    // The request's own deadline, not a fixed 24 hours.
    expect(items.find((item: { kind: string }) => item.kind === 'REQUESTS')).toMatchObject({
      urgent: true,
      detail: `Answer by ${formatNzDateTime(requestExpiresAt)} (NZ time).`,
    });
    expect(items.find((item: { kind: string }) => item.kind === 'DOCUMENT_EXPIRING')).toMatchObject({
      title: '2021 Toyota Corolla: WOF expires soon',
      urgent: true,
    });
    expect(items[items.length - 1].urgent).toBe(false);
  });
});

describe('maintenance reminders', () => {
  it('saves the list, needs a date or reading, and marks one done', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const agent = await signIn(host.email);
    const path = `/api/v1/host/vehicles/${vehicle.id}/maintenance-reminders`;

    const missing = await agent.put(path).send({ reminders: [{ title: 'Service' }] });
    expect(missing.body.error.fields['reminders.0.dueAt']).toBe('Choose a date or an odometer reading');

    const saved = await agent.put(path).send({
      reminders: [
        { title: 'Service', dueAt: '2026-12-01', notes: 'At the usual garage' },
        { title: 'New tyres', dueOdometer: 60000 },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.reminders).toEqual([
      expect.objectContaining({ title: 'Service', dueAt: '2026-12-01', notes: 'At the usual garage' }),
      expect.objectContaining({ title: 'New tyres', dueOdometer: 60000 }),
    ]);

    const done = await agent.put(path).send({
      reminders: [{ ...saved.body.reminders[0], done: true }, saved.body.reminders[1]],
    });
    expect(done.body.reminders[0]).toMatchObject({
      id: saved.body.reminders[0].id,
      doneAt: expect.any(String),
    });

    const other = await createUser({ email: 'nosy@example.co.nz' });
    expect((await (await signIn(other.email)).get(path)).status).toBe(403);
  });
});

describe('daily Host reminders', () => {
  it('remind about documents at 30 and 7 days, once each, and alert support close to a booked trip', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const vehicle = await createVehicle(host._id, {
      regoExpiry: new Date(Date.now() + 20 * DAY_MS),
      wofExpiry: new Date(Date.now() + 2 * DAY_MS),
    });
    // A trip in 2 days that ends after the WOF expires.
    await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { startAt: new Date(Date.now() + 1.5 * DAY_MS), endAt: new Date(Date.now() + 4 * DAY_MS) },
    );

    await runHostReminders();
    const expiring = await NotificationModel.find({
      userId: host._id,
      type: 'DOCUMENT_EXPIRING',
      channel: 'IN_APP',
    });
    expect(expiring.map((notification) => (notification.payload as { title: string }).title).sort()).toEqual([
      expect.stringMatching(/^2021 Toyota Corolla: Rego expires/),
      expect.stringMatching(/^2021 Toyota Corolla: WOF expires/),
    ]);
    expect(await NotificationModel.countDocuments({ userId: host._id, type: 'DOCUMENT_BEFORE_TRIP' })).toBe(
      2,
    );
    expect(await NotificationModel.countDocuments({ type: 'DOCUMENT_BEFORE_TRIP', channel: 'EMAIL' })).toBe(
      2,
    );
    expect(await JobModel.countDocuments({ type: 'daily.hostReminders' })).toBe(1);

    // The next day's run sends nothing new.
    const before = await NotificationModel.countDocuments({});
    await runHostReminders();
    expect(await NotificationModel.countDocuments({})).toBe(before);
  });

  it('cover a booked car whose key details are being checked again', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const admin = await createStaff('aroha@example.co.nz', 'ADMIN');
    const expiring = { wofExpiry: new Date(Date.now() + 2 * DAY_MS) };
    const underReview = await createVehicle(host._id, { status: 'UNDER_REVIEW', ...expiring });
    const changes = await createVehicle(host._id, { status: 'CHANGES_REQUESTED', ...expiring });
    const draft = await createVehicle(host._id, { status: 'DRAFT', ...expiring });
    const trips = [];
    for (const car of [underReview, changes, draft]) {
      trips.push(
        await createBookingRecord(
          { guestId: guest._id, hostId: host._id, vehicleId: car._id },
          { startAt: new Date(Date.now() + 1.5 * DAY_MS), endAt: new Date(Date.now() + 4 * DAY_MS) },
        ),
      );
    }

    await runHostReminders();
    const before = await NotificationModel.find({
      userId: host._id,
      type: 'DOCUMENT_BEFORE_TRIP',
      channel: 'IN_APP',
    });
    expect(before.map((notification) => (notification.payload as { title: string }).title).sort()).toEqual(
      [`WOF runs out before ${trips[0]!.ref} ends`, `WOF runs out before ${trips[1]!.ref} ends`].sort(),
    );
    // Within 72 hours of the start, support is alerted too.
    expect(
      await NotificationModel.countDocuments({
        type: 'DOCUMENT_BEFORE_TRIP',
        userId: admin._id,
        channel: 'IN_APP',
      }),
    ).toBe(2);
    expect(
      await NotificationModel.countDocuments({
        userId: host._id,
        type: 'DOCUMENT_EXPIRING',
        channel: 'IN_APP',
      }),
    ).toBe(2);
  });

  it('tell the Host a renewal they uploaded is waiting for our check, and ask support to check it', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const admin = await createStaff('aroha@example.co.nz', 'ADMIN');
    // An approved car's new WOF date waits for our team to check the document showing it (plan §3).
    const vehicle = await createVehicle(host._id, {
      wofExpiry: new Date(Date.now() + 2 * DAY_MS),
      pendingExpiries: { wofExpiry: new Date(Date.now() + 365 * DAY_MS) },
      documents: [{ type: 'WOF', url: 'vehicle-documents/new-wof.pdf', status: 'PENDING' }],
    });
    const booking = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { startAt: new Date(Date.now() + 1.5 * DAY_MS), endAt: new Date(Date.now() + 4 * DAY_MS) },
    );

    const { items } = (await (await signIn(host.email)).get('/api/v1/host/todo')).body;
    expect(items.find((item: { kind: string }) => item.kind === 'DOCUMENT_EXPIRING')).toMatchObject({
      title: '2021 Toyota Corolla: new WOF waiting for our check',
      detail: expect.stringContaining('Nothing more to upload'),
      urgent: false,
    });

    await runHostReminders();
    const titles = async (userId: typeof host._id, type: string) =>
      (await NotificationModel.find({ userId, type, channel: 'IN_APP' }))
        .map((notification) => (notification.payload as { title: string }).title)
        .sort();
    expect(await titles(host._id, 'DOCUMENT_EXPIRING')).toEqual([
      '2021 Toyota Corolla: new WOF waiting for our check',
    ]);
    expect(await titles(host._id, 'DOCUMENT_BEFORE_TRIP')).toEqual([
      `New WOF waiting for our check before ${booking.ref}`,
    ]);
    const email = await NotificationModel.findOne({
      userId: host._id,
      type: 'DOCUMENT_BEFORE_TRIP',
      channel: 'EMAIL',
    });
    expect(email!.payload).toMatchObject({ props: { buttonLabel: 'See the documents' } });
    // Support checks the document first, on the car's review page.
    const alert = await NotificationModel.findOne({
      userId: admin._id,
      type: 'DOCUMENT_BEFORE_TRIP',
      channel: 'IN_APP',
    });
    expect(alert!.payload).toMatchObject({
      title: `${booking.ref}: the car's new WOF is waiting for our check`,
      link: `/admin/vehicles/${vehicle.id}`,
    });

    // Our team couldn't accept it: the Host is asked for a renewal again, and support to contact both.
    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { 'documents.0.status': 'REJECTED' } });
    await runHostReminders();
    expect(await titles(host._id, 'DOCUMENT_BEFORE_TRIP')).toEqual(
      [
        `New WOF waiting for our check before ${booking.ref}`,
        `WOF runs out before ${booking.ref} ends`,
      ].sort(),
    );
    expect(await titles(host._id, 'DOCUMENT_EXPIRING')).toEqual([
      expect.stringMatching(/^2021 Toyota Corolla: WOF expires/),
      '2021 Toyota Corolla: new WOF waiting for our check',
    ]);
    expect(await titles(admin._id, 'DOCUMENT_BEFORE_TRIP')).toEqual(
      [
        `${booking.ref}: the car's new WOF is waiting for our check`,
        `${booking.ref}: the car's WOF runs out during the trip`,
      ].sort(),
    );
  });

  it('count a Road User Charges licence that would run out on a booked trip’s kilometres', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    // 600 km left on the licence; a 3-day trip allows 250 km a day.
    const vehicle = await createVehicle(host._id, { fuelType: 'DIESEL', rucValidToKm: 45_600 });
    const roomy = await createVehicle(host._id, { fuelType: 'DIESEL', rucValidToKm: 60_000 });
    for (const car of [vehicle, roomy]) {
      const earlier = await createBookingRecord(
        { guestId: guest._id, hostId: host._id, vehicleId: car._id },
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
    }
    const booked = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { startAt: new Date(Date.now() + 10 * DAY_MS) },
    );
    await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: roomy._id },
      { startAt: new Date(Date.now() + 10 * DAY_MS) },
    );

    await runHostReminders();
    const before = await NotificationModel.find({
      userId: host._id,
      type: 'DOCUMENT_BEFORE_TRIP',
      channel: 'IN_APP',
    });
    expect(before.map((notification) => (notification.payload as { title: string }).title)).toEqual([
      `RUC licence runs out before ${booked.ref} ends`,
    ]);
  });
});
