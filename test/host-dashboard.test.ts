import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { runHostReminders } from '../src/modules/hosts/host-reminders.service.js';
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
    await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'PENDING', instantBook: false, requestExpiresAt: new Date(Date.now() + DAY_MS) },
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
});
