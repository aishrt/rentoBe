import { describe, expect, it } from 'vitest';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { REQUIRED_INSPECTION_ANGLES } from '../src/modules/inspections/condition-report.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * Handover edge cases (spec §14, plan §8.2): a trip support marked as started without a check-in can still
 * be checked out by either party, and flagged damage photos are photos of damage.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
type Agent = ReturnType<typeof browserAgent>;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

async function trip() {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  await UserModel.updateOne({ _id: guest._id }, { $set: { emailVerifiedAt: new Date() } });
  const vehicle = await createVehicle(host._id);
  const startAt = new Date(Date.now() + HOUR_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  return {
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

describe('a trip support marked as started', () => {
  it('can be checked out by either party, with no check-in to compare with', async () => {
    const { booking, guestAgent, hostAgent } = await trip();
    await createStaff();
    const staff = await staffAgent();
    const started = await staff
      .post(`/api/v1/admin/bookings/${booking.ref}/status`)
      .send({ to: 'ACTIVE', reason: 'Keys handed over in person; the app was down.' });
    expect(started.status).toBe(200);

    for (const agent of [guestAgent, hostAgent]) {
      const handover = (await agent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
      expect(handover).toMatchObject({
        bookingStatus: 'ACTIVE',
        checkIn: null,
        actions: { checkIn: false, checkOut: true },
      });
    }

    const shots = await photos(guestAgent, booking.ref);
    const done = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 46000,
      fuelOrBatteryPct: 50,
      photos: shots,
    });
    expect(done.status).toBe(201);
    expect(done.body.handover).toMatchObject({
      bookingStatus: 'COMPLETED',
      checkIn: null,
      checkOut: { submittedBy: 'GUEST', odometer: 46000, completedBySupport: false },
      fuelShortfall: false,
      actions: { checkOut: false },
    });
    // Nothing to work extra kilometres out against.
    expect(done.body.handover.kilometres).toBeUndefined();
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toEqual([]);

    // Done once.
    const hostShots = await photos(hostAgent, booking.ref);
    const again = await hostAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 46100,
      fuelOrBatteryPct: 50,
      photos: hostShots,
    });
    expect(again.body.error.code).toBe('NOT_CHECK_OUT');
  });

  it('still can’t be checked out before it’s under way', async () => {
    const { booking, guestAgent } = await trip();
    const handover = (await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    expect(handover.actions.checkOut).toBe(false);
    const shots = await photos(guestAgent, booking.ref);
    const early = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 46000,
      fuelOrBatteryPct: 50,
      photos: shots,
    });
    expect(early.body.error.code).toBe('NOT_CHECK_OUT');
  });
});

describe('flagging damage', () => {
  it('takes only photos of damage', async () => {
    const { booking, guestAgent, hostAgent } = await trip();
    const checkInShots = await photos(hostAgent, booking.ref);
    const checkIn = await hostAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_IN',
      odometer: 45000,
      fuelOrBatteryPct: 80,
      photos: checkInShots,
    });
    expect(checkIn.status).toBe(201);
    const checkOutShots = await photos(guestAgent, booking.ref);
    const checkOut = await guestAgent.post(`/api/v1/bookings/${booking.ref}/inspections`).send({
      stage: 'CHECK_OUT',
      odometer: 45100,
      fuelOrBatteryPct: 80,
      photos: checkOutShots,
    });
    expect(checkOut.status).toBe(201);

    const front = await photos(hostAgent, booking.ref, ['FRONT']);
    const refused = await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 60, y: 40 }], photos: front });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');

    const damage = await photos(hostAgent, booking.ref, ['DAMAGE']);
    const flagged = await hostAgent
      .post(`/api/v1/bookings/${booking.ref}/inspections/CHECK_OUT/damage`)
      .send({ damagePins: [{ x: 60, y: 40 }], photos: damage });
    expect(flagged.status).toBe(200);
    const added = flagged.body.handover.checkOut.photos.filter(
      (photo: { angle: string; takenBy: string }) => photo.takenBy === 'HOST',
    );
    expect(added.map((photo: { angle: string }) => photo.angle)).toEqual(['DAMAGE']);
  });
});
