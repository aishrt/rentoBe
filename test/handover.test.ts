import { describe, expect, it } from 'vitest';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { tripExtraChargesJob } from '../src/jobs/handlers/payout-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
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

  it('refuses to start a trip the guest’s licence doesn’t cover, saying why to each side', async () => {
    const { booking, guestAgent, hostAgent, guest } = await trip();
    const licence = (overrides: object) =>
      UserModel.updateOne(
        { _id: guest._id },
        {
          $set: {
            dob: new Date('1990-04-21T00:00:00+12:00'),
            driverLicence: {
              numberHash: 'hash',
              numberEnding: '456',
              country: 'NZ',
              class: 'NZ_FULL',
              issuedAt: new Date('2012-05-01T00:00:00+12:00'),
              expiry: new Date(Date.now() + 30 * DAY_MS),
              status: 'APPROVED',
              ...overrides,
            },
          },
        },
      );
    const checkIn = async (agent: Agent) => {
      const shots = await photos(agent, booking.ref);
      return agent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
        stage: 'CHECK_IN',
        odometer: 1000,
        fuelOrBatteryPct: 50,
        photos: shots,
      });
    };

    // It runs out the day after pick-up, before the trip ends.
    await licence({ expiry: new Date(Date.now() + DAY_MS) });
    const expiring = await checkIn(guestAgent);
    expect(expiring.status).toBe(409);
    expect(expiring.body.error).toMatchObject({
      code: 'LICENCE_NOT_ELIGIBLE',
      message: expect.stringMatching(/^Your driver licence can’t be used for this trip: it expires before/),
    });
    // Turned down by support, or a class that isn't accepted: the host hears it too.
    await licence({ status: 'REJECTED' });
    const rejected = await checkIn(hostAgent);
    expect(rejected.body.error).toMatchObject({
      code: 'LICENCE_NOT_ELIGIBLE',
      message: expect.stringMatching(/^The guest’s driver licence can’t be used for this trip \(our team/),
    });
    await licence({ class: 'NZ_RESTRICTED' });
    expect((await checkIn(guestAgent)).body.error.code).toBe('LICENCE_NOT_ELIGIBLE');
    expect((await BookingModel.findById(booking._id).lean())!.status).toBe('CONFIRMED');

    // Valid for the whole trip: it starts.
    await licence({});
    expect((await checkIn(guestAgent)).status).toBe(201);
  });

  it('keeps when a chosen photo says it was taken and where the device was, and shows the place to staff only', async () => {
    const { booking, hostAgent, guestAgent } = await trip();
    const shots = await photos(hostAgent, booking.ref);
    const record = (photos: object[]) =>
      hostAgent
        .post(`/api/v1/bookings/${booking.ref}/inspections`)
        .send({ stage: 'CHECK_IN', odometer: 45210, fuelOrBatteryPct: 80, photos });
    const [first, ...rest] = shots;
    const auckland = { lat: -36.84846, lng: 174.76334 };

    // Out of range, half a position, or EXIF's own date format: refused.
    for (const wrong of [
      { ...first, lat: 120, lng: 174 },
      { ...first, lat: -36.8 },
      { ...first, exifTakenAt: '2026:01:05 09:30:00' },
    ]) {
      const refused = await record([wrong, ...rest]);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    }

    const done = await record([
      { ...first, ...auckland, exifTakenAt: '2026-01-05T09:30:00+13:00' },
      ...rest.map((shot) => ({ ...shot, ...auckland })),
    ]);
    expect(done.status).toBe(201);
    const stored = await ConditionReportModel.findOne({ bookingId: booking._id }).lean();
    expect(stored!.photos[0]).toMatchObject({
      exifTakenAt: new Date('2026-01-04T20:30:00.000Z'),
      ...auckland,
    });
    expect(stored!.photos[1]!.exifTakenAt).toBeUndefined();
    expect(stored!.photos[1]).toMatchObject(auckland);

    const forGuest = (await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    expect(forGuest.checkIn.photos[0]).toMatchObject({ exifTakenAt: '2026-01-04T20:30:00.000Z' });
    expect(forGuest.checkIn.photos[0].lat).toBeUndefined();
    expect(forGuest.checkIn.photos[1].exifTakenAt).toBeUndefined();

    await createStaff('sam@example.co.nz', 'SUPPORT');
    const staff = await staffAgent('sam@example.co.nz');
    const forStaff = (await staff.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    expect(forStaff.checkIn.photos[0]).toMatchObject({
      exifTakenAt: '2026-01-04T20:30:00.000Z',
      ...auckland,
    });
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

  /** Moves the check-out back in time; createdAt is immutable in Mongoose, so in the database itself. */
  async function checkOutHoursAgo(bookingId: unknown, hours: number) {
    await ConditionReportModel.collection.updateOne(
      { bookingId, stage: 'CHECK_OUT' },
      { $set: { createdAt: new Date(Date.now() - hours * HOUR_MS) } },
    );
  }

  const flag = (agent: Agent, ref: string, body: object) =>
    agent.post(`/api/v1/bookings/${ref}/inspections/CHECK_OUT/damage`).send(body);

  it('lets either party flag new damage until the damage-report window closes', async () => {
    const { booking, guestAgent, hostAgent } = await checkedIn();
    // Only once there's a check-out to add it to.
    const tooSoon = await flag(guestAgent, booking.ref, { damagePins: [{ x: 50, y: 50 }] });
    expect(tooSoon.body.error).toMatchObject({
      code: 'DAMAGE_WINDOW_CLOSED',
      message: 'New damage is flagged at check-out.',
    });

    const shots6 = await photos(guestAgent, booking.ref);
    await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 45100,
      fuelOrBatteryPct: 80,
      photos: shots6,
    });
    // The Guest did the check-out, so it counts as confirmed on their side: that doesn't stop them flagging.
    const forGuest = (await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    expect(forGuest.checkOut.confirmedByGuestAt).toEqual(expect.any(String));
    expect(forGuest.actions.flagDamage).toBe(true);
    await checkOutHoursAgo(booking._id, 47);
    const guestFlag = await flag(guestAgent, booking.ref, {
      damagePins: [{ x: 50, y: 6, note: 'Chip in the windscreen' }],
    });
    expect(guestFlag.status).toBe(200);

    await hostAgent.post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/confirm`);
    const shots7 = await photos(hostAgent, booking.ref, ['DAMAGE']);
    const flagged = await flag(hostAgent, booking.ref, {
      damagePins: [{ x: 60, y: 40 }],
      photos: shots7,
      note: 'Dent in the rear door',
    });
    expect(flagged.status).toBe(200);
    expect(flagged.body.handover.checkOut.damagePins).toEqual([
      expect.objectContaining({
        x: 50,
        y: 6,
        newDamage: true,
        flaggedBy: 'GUEST',
        note: 'Chip in the windscreen',
      }),
      expect.objectContaining({
        x: 60,
        y: 40,
        newDamage: true,
        flaggedBy: 'HOST',
        note: 'Dent in the rear door',
      }),
    ]);

    await checkOutHoursAgo(booking._id, 49);
    for (const agent of [guestAgent, hostAgent]) {
      const handover = (await agent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
      expect(handover.actions.flagDamage).toBe(false);
      const closed = await flag(agent, booking.ref, { damagePins: [{ x: 10, y: 10 }] });
      expect(closed.body.error.code).toBe('DAMAGE_WINDOW_CLOSED');
    }
  });

  it('closes the window for a Guest who never confirmed the Host’s check-out', async () => {
    const { booking, guestAgent, hostAgent } = await checkedIn();
    const shots = await photos(hostAgent, booking.ref);
    await hostAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 45100,
      fuelOrBatteryPct: 80,
      photos: shots,
    });
    const inside = await flag(guestAgent, booking.ref, { damagePins: [{ x: 13, y: 79 }] });
    expect(inside.status).toBe(200);
    expect(inside.body.handover.checkOut.confirmedByGuestAt).toBeUndefined();

    await checkOutHoursAgo(booking._id, 49);
    const forGuest = (await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    expect(forGuest.actions).toMatchObject({ confirmCheckOut: true, flagDamage: false });
    const late = await flag(guestAgent, booking.ref, { damagePins: [{ x: 10, y: 10 }] });
    expect(late.body.error.code).toBe('DAMAGE_WINDOW_CLOSED');
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

  it('shows staff both reports, and lets support complete a trip with the Host’s readings alone', async () => {
    const { booking } = await checkedIn();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const staff = await staffAgent('sam@example.co.nz');

    // Staff read the handover like the parties do, with nothing for them to confirm.
    const before = await staff.get(`/api/v1/bookings/${booking.ref}/inspections`);
    expect(before.status).toBe(200);
    expect(before.body.handover).toMatchObject({
      role: 'STAFF',
      bookingStatus: 'ACTIVE',
      checkIn: { submittedBy: 'HOST', odometer: 45000, confirmedByHostAt: expect.any(String) },
      checkOut: null,
      actions: { checkIn: false, checkOut: false, confirmCheckIn: false, confirmCheckOut: false },
    });
    expect(before.body.handover.checkIn.photos[0]).toMatchObject({
      takenBy: 'HOST',
      takenAt: expect.any(String),
    });

    const lower = await staff
      .post(`/api/v1/admin/bookings/${booking.ref}/complete`)
      .send({ odometer: 44000, fuelOrBatteryPct: 70 });
    expect(lower.body.error.fields.odometer).toMatch(/45,000/);
    const missing = await staff
      .post(`/api/v1/admin/bookings/${booking.ref}/complete`)
      .send({ odometer: 46000 });
    expect(missing.body.error.fields.fuelOrBatteryPct).toBeDefined();

    // 800 km driven, 750 included: the same extra-kilometre charge as a check-out in the app.
    const completed = await staff
      .post(`/api/v1/admin/bookings/${booking.ref}/complete`)
      .send({ odometer: 45800, fuelOrBatteryPct: 60, notes: 'From the Host’s photo of the dashboard' });
    expect(completed.status).toBe(200);
    expect(completed.body.handover).toMatchObject({
      bookingStatus: 'COMPLETED',
      checkOut: {
        submittedBy: 'STAFF',
        completedBySupport: true,
        odometer: 45800,
        fuelOrBatteryPct: 60,
        notes: 'From the Host’s photo of the dashboard',
        photos: [],
      },
      kilometres: { driven: 800, allowance: 750, extra: 50, extraChargeCents: 1750 },
    });
    const stored = await BookingModel.findById(booking._id).lean();
    expect(stored!.statusHistory.at(-1)).toMatchObject({
      status: 'COMPLETED',
      reason: 'Completed by support: check-out was missing',
    });
    expect(await JobModel.countDocuments({ type: 'trip.extraCharges', refId: booking.id })).toBe(1);
    await tripExtraChargesJob({ bookingId: booking.id }, {
      log: { info: () => undefined, warn: () => undefined },
    } as unknown as JobContext);
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toEqual([
      expect.objectContaining({ type: 'EXTRA_KM', amountCents: 1750, status: 'PENDING' }),
    ]);
    expect(await AuditLogModel.findOne({ action: 'booking.completed-by-support' }).lean()).toMatchObject({
      after: { status: 'COMPLETED', odometer: 45800, fuelOrBatteryPct: 60, photos: 0 },
    });
    const again = await staff
      .post(`/api/v1/admin/bookings/${booking.ref}/complete`)
      .send({ odometer: 45900, fuelOrBatteryPct: 60 });
    expect(again.body.error.code).toBe('NOT_CHECK_OUT');
  });

  it('lets support complete a trip started without a check-in, with no extra kilometres to work out', async () => {
    const { booking } = await trip();
    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'ACTIVE' } });
    await createStaff();
    const staff = await staffAgent();
    const completed = await staff
      .post(`/api/v1/admin/bookings/${booking.ref}/complete`)
      .send({ odometer: 46000, fuelOrBatteryPct: 50 });
    expect(completed.status).toBe(200);
    expect(completed.body.handover).toMatchObject({
      bookingStatus: 'COMPLETED',
      checkIn: null,
      checkOut: { odometer: 46000, completedBySupport: true },
    });
    expect(completed.body.handover.kilometres).toBeUndefined();
  });
});

describe('extra kilometres after check-out (plan §3, §8.2)', () => {
  /** The Host checked in at 45,000 km and the Guest checked out at `odometer`. */
  async function checkedOut(odometer = 45800) {
    const parts = await trip();
    const checkInShots = await photos(parts.hostAgent, parts.booking.ref);
    await parts.hostAgent.post(`/api/v1/bookings/${parts.booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 45000,
      fuelOrBatteryPct: 80,
      photos: checkInShots,
    });
    const checkOutShots = await photos(parts.guestAgent, parts.booking.ref);
    const done = await parts.guestAgent.post(`/api/v1/bookings/${parts.booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer,
      fuelOrBatteryPct: 80,
      photos: checkOutShots,
    });
    expect(done.status).toBe(201);
    return parts;
  }

  const extraKmJob = (bookingId: string) =>
    JobModel.findOne({ type: 'trip.extraCharges', refId: bookingId }).lean();
  const runJob = (bookingId: string) =>
    tripExtraChargesJob({ bookingId }, {
      log: { info: () => undefined, warn: () => undefined },
    } as unknown as JobContext);

  it('are charged once the other party confirms the check-out, or when the damage-report window closes', async () => {
    const { booking, hostAgent } = await checkedOut();
    // 48 hours by default, from the check-out.
    const queued = await extraKmJob(booking.id);
    expect(queued!.status).toBe('QUEUED');
    expect(queued!.runAt.getTime()).toBeGreaterThan(Date.now() + 47 * HOUR_MS);

    const confirmed = await hostAgent.post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/confirm`);
    expect(confirmed.status).toBe(200);
    expect((await extraKmJob(booking.id))!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('lets staff with the refunds permission correct a mistyped reading, which works the charge out again', async () => {
    const { booking, guest } = await checkedOut();
    await runJob(booking.id);
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toEqual([
      expect.objectContaining({ type: 'EXTRA_KM', amountCents: 1750, status: 'PENDING' }),
    ]);
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const support = await staffAgent('mere@example.co.nz');
    const correct = (agent: Agent, body: object) =>
      agent.post(`/api/v1/admin/bookings/${booking.ref}/readings`).send(body);
    const note = 'Read again from the dashboard photo';
    expect((await correct(support, { stage: 'CHECK_OUT', odometer: 45900, note })).status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    expect(
      (await correct(admin, { stage: 'CHECK_OUT', odometer: 45900 })).body.error.fields.note,
    ).toBeDefined();
    const lower = await correct(admin, { stage: 'CHECK_OUT', odometer: 44000, note });
    expect(lower.status).toBe(400);
    expect(lower.body.error.fields.odometer).toMatch(/45,000/);

    // 900 km driven: 150 extra, so $52.50 in place of $17.50.
    const fixed = await correct(admin, { stage: 'CHECK_OUT', odometer: 45900, note });
    expect(fixed.status).toBe(200);
    expect(fixed.body.handover.checkOut.odometer).toBe(45900);
    expect(fixed.body.extraKm).toMatchObject({ outcome: 'CHARGED', amountCents: 5250 });
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toEqual([
      expect.objectContaining({ amountCents: 1750, status: 'CANCELLED' }),
      expect.objectContaining({ type: 'EXTRA_KM', amountCents: 5250, status: 'PENDING' }),
    ]);
    expect(
      await AuditLogModel.findOne({ action: 'booking.reading-corrected', entityId: booking.id }).lean(),
    ).toMatchObject({
      before: { stage: 'CHECK_OUT', odometer: 45800 },
      after: { stage: 'CHECK_OUT', odometer: 45900, note },
    });
    expect(
      await NotificationModel.findOne({
        userId: guest._id,
        type: 'EXTRA_CHARGE_CANCELLED',
        channel: 'IN_APP',
      }),
    ).toMatchObject({ payload: { title: `Charge corrected for ${booking.ref}` } });

    // Paid already, then corrected down: the difference is left for staff to refund.
    await BookingModel.updateOne(
      { _id: booking._id, 'extraCharges.amountCents': 5250 },
      { $set: { 'extraCharges.$.status': 'SUCCEEDED' } },
    );
    const down = await correct(admin, { stage: 'CHECK_OUT', odometer: 45800, note });
    expect(down.body.extraKm).toMatchObject({ outcome: 'OVERCHARGED', refundCents: 3500 });
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toHaveLength(2);
  });

  it('lets staff charge them now, as for one held above the daily review limit', async () => {
    const { booking } = await checkedOut();
    await createStaff();
    const admin = await staffAgent();
    const charged = await admin.post(`/api/v1/admin/bookings/${booking.ref}/extra-km`);
    expect(charged.status).toBe(200);
    expect(charged.body.extraKm).toMatchObject({ outcome: 'CHARGED', amountCents: 1750 });
    // The job that would have charged it later has nothing left to do.
    expect((await extraKmJob(booking.id))!.status).toBe('CANCELLED');
    const again = await admin.post(`/api/v1/admin/bookings/${booking.ref}/extra-km`);
    expect(again.body.extraKm).toMatchObject({ outcome: 'UNCHANGED' });
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toHaveLength(1);
  });
});
