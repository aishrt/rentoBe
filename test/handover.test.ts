import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import {
  ConditionReportModel,
  REQUIRED_INSPECTION_ANGLES,
} from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
type Agent = ReturnType<typeof browserAgent>;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A confirmed trip starting within the hour, with both sides signed in. */
async function trip(overrides: Parameters<typeof createBookingRecord>[1] = {}) {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  await UserModel.updateOne({ _id: guest._id }, { $set: { emailVerifiedAt: new Date() } });
  const vehicle = await createVehicle(host._id);
  const startAt = new Date(Date.now() + HOUR_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS), ...overrides },
  );
  return {
    host,
    guest,
    vehicle,
    booking,
    guestAgent: await signIn('kiri@example.co.nz'),
    hostAgent: await signIn('hana@example.co.nz'),
  };
}

/** Uploads one photo for each angle, the way the website does, and returns them for the report. */
async function photos(agent: Agent, ref: string, angles: readonly string[] = REQUIRED_INSPECTION_ANGLES) {
  const taken = [];
  for (const angle of angles) {
    const body = Buffer.from(`photo-${angle}`);
    const target = await agent
      .post('/api/v1/uploads/signature')
      .send({ purpose: 'INSPECTION_PHOTO', bookingId: ref, contentType: 'image/jpeg', size: body.length });
    expect(target.status).toBe(200);
    await agent.put(new URL(target.body.url).pathname).set('Content-Type', 'image/jpeg').send(body);
    taken.push({ angle, key: target.body.key, takenAt: new Date().toISOString() });
  }
  return taken;
}

describe('check-in', () => {
  it('starts the trip, asks the other side to confirm and queues the late-return checks', async () => {
    const { booking, hostAgent, guestAgent, guest } = await trip();
    const before = await hostAgent.get(`/api/v1/bookings/${booking.ref}/inspections`);
    expect(before.body.handover).toMatchObject({
      role: 'HOST',
      energy: 'FUEL',
      checkIn: null,
      actions: { checkIn: true, checkOut: false },
    });

    const shots = await photos(hostAgent, booking.ref);
    const done = await hostAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 45210,
      fuelOrBatteryPct: 80,
      photos: shots,
      damagePins: [{ x: 20, y: 30, note: 'Scuff on the front bumper' }],
    });
    expect(done.status).toBe(201);
    expect(done.body.handover.checkIn).toMatchObject({
      submittedBy: 'HOST',
      odometer: 45210,
      confirmedByHostAt: expect.any(String),
      damagePins: [{ x: 20, y: 30, newDamage: false, flaggedBy: 'HOST' }],
    });
    expect(done.body.handover.checkIn.photos).toHaveLength(8);
    expect(done.body.handover.checkIn.photos[0].url).toMatch(/\/files\/private\/bookings\//);
    expect((await BookingModel.findById(booking._id))!.status).toBe('ACTIVE');
    expect(await JobModel.countDocuments({ type: 'trip.returnCheck', refId: booking.id })).toBe(2);
    expect(
      await NotificationModel.countDocuments({ userId: guest._id, type: 'CHECK_IN_DONE', channel: 'EMAIL' }),
    ).toBe(1);

    const forGuest = await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`);
    expect(forGuest.body.handover.actions).toMatchObject({ confirmCheckIn: true, checkOut: true });
    const confirmed = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_IN/confirm`);
    expect(confirmed.body.handover.checkIn.confirmedByGuestAt).toEqual(expect.any(String));
    expect(confirmed.body.handover.actions.confirmCheckIn).toBe(false);
  });

  it('opens 2 hours before the start, needs every angle and a confirmed email', async () => {
    const later = await trip({
      startAt: new Date(Date.now() + 10 * DAY_MS),
      endAt: new Date(Date.now() + 12 * DAY_MS),
    });
    const early = await later.hostAgent.post(`/api/v1/bookings/${later.booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 1000,
      fuelOrBatteryPct: 50,
      photos: [{ angle: 'FRONT', key: 'x', takenAt: new Date().toISOString() }],
    });
    expect(early.body.error.code).toBe('TOO_EARLY');
    await BookingModel.deleteMany({});
    await UserModel.deleteMany({});
    await VehicleModel.deleteMany({});

    const { booking, guestAgent, guest } = await trip();
    const shots1 = await photos(guestAgent, booking.ref, ['FRONT', 'REAR']);
    const partial = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 1000,
      fuelOrBatteryPct: 50,
      photos: shots1,
    });
    expect(partial.body.error.code).toBe('PHOTOS_MISSING');
    expect(partial.body.error.fields.photos).toMatch(/driver side/);

    await UserModel.updateOne({ _id: guest._id }, { $unset: { emailVerifiedAt: 1 } });
    expect(
      (await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover
        .emailVerificationNeeded,
    ).toBe(true);
    const shots2 = await photos(guestAgent, booking.ref);
    const unverified = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 1000,
      fuelOrBatteryPct: 50,
      photos: shots2,
    });
    expect(unverified.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('check-out', () => {
  async function checkedIn() {
    const parts = await trip();
    const shots3 = await photos(parts.hostAgent, parts.booking.ref);
    const checkIn = await parts.hostAgent.post(`/api/v1/bookings/${parts.booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 45000,
      fuelOrBatteryPct: 80,
      photos: shots3,
    });
    expect(checkIn.status).toBe(201);
    return parts;
  }

  it('completes the trip and works out the extra kilometres', async () => {
    const { booking, guestAgent, host, vehicle } = await checkedIn();
    const shots4 = await photos(guestAgent, booking.ref);
    const lower = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 44000,
      fuelOrBatteryPct: 80,
      photos: shots4,
    });
    expect(lower.body.error.fields.odometer).toMatch(/45,000/);

    // 3 days at 250 km a day: 750 km included; 800 driven is 50 extra at 35 cents.
    const shots5 = await photos(guestAgent, booking.ref);
    const done = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 45800,
      fuelOrBatteryPct: 40,
      photos: shots5,
    });
    expect(done.status).toBe(201);
    expect(done.body.handover).toMatchObject({
      bookingStatus: 'COMPLETED',
      kilometres: { driven: 800, allowance: 750, extra: 50, extraChargeCents: 1750 },
      fuelShortfall: true,
      damageWindowEndsAt: expect.any(String),
    });
    expect((await BookingModel.findById(booking._id))!.status).toBe('COMPLETED');
    expect((await VehicleModel.findById(vehicle._id))!.tripCount).toBe(1);
    expect((await UserModel.findById(host._id))!.hostProfile!.tripCount).toBe(4);
    expect(await NotificationModel.countDocuments({ type: 'TRIP_COMPLETED', channel: 'IN_APP' })).toBe(2);
  });

  it('lets the host flag new damage until the window closes', async () => {
    const { booking, guestAgent, hostAgent } = await checkedIn();
    const shots6 = await photos(guestAgent, booking.ref);
    await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 45100,
      fuelOrBatteryPct: 80,
      photos: shots6,
    });
    const shots7 = await photos(hostAgent, booking.ref, ['DAMAGE']);
    await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/confirm`);
    const guestLate = await guestAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 50, y: 50 }] });
    expect(guestLate.body.error.code).toBe('DAMAGE_WINDOW_CLOSED');

    const flagged = await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({
        damagePins: [{ x: 60, y: 40 }],
        photos: shots7,
        note: 'Dent in the rear door',
      });
    expect(flagged.status).toBe(200);
    expect(flagged.body.handover.checkOut.damagePins).toEqual([
      expect.objectContaining({
        x: 60,
        y: 40,
        newDamage: true,
        flaggedBy: 'HOST',
        note: 'Dent in the rear door',
      }),
    ]);

    // createdAt is immutable in Mongoose: move it back in the database itself.
    await ConditionReportModel.collection.updateOne(
      { bookingId: booking._id, stage: 'CHECK_OUT' },
      { $set: { createdAt: new Date(Date.now() - 49 * HOUR_MS) } },
    );
    const closed = await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 10, y: 10 }] });
    expect(closed.body.error.code).toBe('DAMAGE_WINDOW_CLOSED');
  });

  it('opens a damage case with the damage flagged at check-out, once', async () => {
    const { booking, guestAgent, hostAgent } = await checkedIn();
    const shots = await photos(guestAgent, booking.ref, [...REQUIRED_INSPECTION_ANGLES, 'DAMAGE']);
    await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 45100,
      fuelOrBatteryPct: 80,
      photos: shots,
      damagePins: [{ x: 50, y: 6, note: 'Chip in the front bumper' }],
    });
    const dent = await photos(hostAgent, booking.ref, ['DAMAGE']);
    await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 80, y: 62 }], photos: dent, note: 'Dent in the rear door' });

    // Only a damage report can take it.
    const toll = await hostAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'TOLL', fromCheckOutDamage: true });
    expect(toll.body.error.fields.fromCheckOutDamage).toMatch(/damage report/);

    const opened = await hostAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'DAMAGE', fromCheckOutDamage: true });
    expect(opened.status).toBe(201);
    const incident = opened.body.incident;
    expect(incident).toMatchObject({ type: 'DAMAGE', reportedBy: 'HOST', status: 'OPEN' });
    expect(incident.description).toBe(
      [
        'New damage flagged on the check-out record: 2 marks on the car diagram and 2 photos.',
        '- Chip in the front bumper (flagged by the guest)',
        '- Dent in the rear door (flagged by the host)',
      ].join('\n'),
    );
    expect(incident.events[0].attachments).toEqual([
      expect.objectContaining({
        name: 'Check-out damage photo 1',
        url: expect.stringMatching(/inspections/),
      }),
      expect.objectContaining({ name: 'Check-out damage photo 2' }),
    ]);

    // That damage is in a case now; the next one takes only what's flagged after it.
    const again = await guestAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'DAMAGE', fromCheckOutDamage: true });
    expect(again.body.error.code).toBe('NO_NEW_DAMAGE');
    await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 13, y: 79, note: 'Kerbed rear wheel' }] });
    const next = await hostAgent.post('/api/v1/incidents').send({
      bookingRef: booking.ref,
      type: 'DAMAGE',
      description: 'Found this one after washing the car.',
      fromCheckOutDamage: true,
    });
    expect(next.status).toBe(201);
    expect(next.body.incident.description).toBe(
      [
        'Found this one after washing the car.',
        '',
        'New damage flagged on the check-out record: 1 mark on the car diagram.',
        '- Kerbed rear wheel (flagged by the host)',
      ].join('\n'),
    );
    expect(next.body.incident.events[0].attachments).toEqual([]);

    // The damage-report window still applies.
    await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 50, y: 95 }] });
    await ConditionReportModel.collection.updateOne(
      { bookingId: booking._id, stage: 'CHECK_OUT' },
      { $set: { createdAt: new Date(Date.now() - 49 * HOUR_MS) } },
    );
    const late = await hostAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'DAMAGE', fromCheckOutDamage: true });
    expect(late.body.error.code).toBe('DAMAGE_WINDOW_CLOSED');
  });

  it('lets support complete a trip whose check-out is missing', async () => {
    const { booking } = await checkedIn();
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    const dashboard = await photos(staff, booking.ref, ['DASHBOARD']);
    const completed = await staff.post(`/api/v1/admin/bookings/${booking.ref}/complete`).send({
      odometer: 45500,
      fuelOrBatteryPct: 70,
      notes: 'From the host’s photos',
      photos: dashboard,
    });
    expect(completed.status).toBe(200);
    expect(completed.body.handover.checkOut).toMatchObject({
      submittedBy: 'STAFF',
      completedBySupport: true,
    });
    expect((await BookingModel.findById(booking._id))!.status).toBe('COMPLETED');
  });
});
