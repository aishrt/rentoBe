import { stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { localFilePath } from '../src/integrations/storage/local-files.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { startCheckJob } from '../src/jobs/handlers/trip-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { enqueue } from '../src/jobs/queue.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import {
  ConditionReportModel,
  REQUIRED_INSPECTION_ANGLES,
} from '../src/modules/inspections/condition-report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
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

async function trip(
  startAt = new Date(Date.now() + HOUR_MS),
  endAt = new Date(startAt.getTime() + 3 * DAY_MS),
) {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  await UserModel.updateOne({ _id: guest._id }, { $set: { emailVerifiedAt: new Date() } });
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { startAt, endAt },
  );
  return {
    booking,
    guest,
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

/** A check-in by the Host with these photos. */
const checkIn = (agent: Agent, ref: string, shots: object[]) =>
  agent
    .post(`/api/v1/bookings/${ref}/inspections`)
    .send({ stage: 'CHECK_IN', odometer: 45000, fuelOrBatteryPct: 80, photos: shots });
const checkOut = (agent: Agent, ref: string, shots: object[]) =>
  agent
    .post(`/api/v1/bookings/${ref}/inspections`)
    .send({ stage: 'CHECK_OUT', odometer: 45100, fuelOrBatteryPct: 80, photos: shots });

describe('inspection photos', () => {
  it('are each attached once: not sent again for check-out, nor one photo for every angle', async () => {
    const { booking, guestAgent, hostAgent } = await trip();
    const shots = await photos(hostAgent, booking.ref);

    // One upload for all 8 angles.
    const oneForAll = await checkIn(
      hostAgent,
      booking.ref,
      shots.map((shot) => ({ ...shot, key: shots[0]!.key })),
    );
    expect(oneForAll.status).toBe(400);
    expect(oneForAll.body.error.fields.photos).toMatch(/twice/);

    // Refused without using any of them up: the same uploads still record the check-in.
    expect((await checkIn(hostAgent, booking.ref, shots)).status).toBe(201);

    // The check-in's uploads, sent again as the check-out's.
    const reused = await checkOut(guestAgent, booking.ref, shots);
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('UPLOAD_NOT_FOUND');
    // Nor by the path a photo's link shows.
    const handover = (await guestAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    const linked = handover.checkIn.photos.map((photo: { angle: string; url: string }) => ({
      angle: photo.angle,
      key: new URL(photo.url).pathname.replace('/api/v1/files/private/', ''),
      takenAt: new Date().toISOString(),
    }));
    expect((await checkOut(guestAgent, booking.ref, linked)).body.error.code).toBe('UPLOAD_NOT_FOUND');
    // A failed attempt deletes what it attached, so its uploads need sending again.
    const fresh = await photos(guestAgent, booking.ref);
    const mixed = await checkOut(guestAgent, booking.ref, [...fresh.slice(1), linked[0]]);
    expect(mixed.body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect((await checkOut(guestAgent, booking.ref, fresh)).body.error.code).toBe('UPLOAD_NOT_FOUND');
    const again = await photos(guestAgent, booking.ref);
    expect((await checkOut(guestAgent, booking.ref, again)).status).toBe(201);
  });

  it('can’t be older than check-in, or for check-out older than the check-in', async () => {
    const { booking, guestAgent, hostAgent } = await trip();
    const shots = await photos(hostAgent, booking.ref);
    // Check-in opened an hour ago (2 hours before the start); the front was taken 2 hours ago.
    const early = await checkIn(hostAgent, booking.ref, [
      { ...shots[0], takenAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() },
      ...shots.slice(1),
    ]);
    expect(early.status).toBe(400);
    expect(early.body.error).toMatchObject({
      code: 'PHOTOS_TOO_EARLY',
      message: 'Some photos were taken before check-in opened. Please take them again.',
      fields: { photos: 'Take again: front' },
    });
    // A clock a few minutes slow is fine.
    const done = await checkIn(hostAgent, booking.ref, [
      { ...shots[0], takenAt: new Date(Date.now() - HOUR_MS - 2 * 60_000).toISOString() },
      ...shots.slice(1),
    ]);
    expect(done.status).toBe(201);

    const back = await photos(guestAgent, booking.ref);
    const old = await checkOut(guestAgent, booking.ref, [
      ...back.slice(0, 7),
      { ...back[7], takenAt: new Date(Date.now() - HOUR_MS).toISOString() },
    ]);
    expect(old.body.error).toMatchObject({
      code: 'PHOTOS_TOO_EARLY',
      message: 'Some photos were taken before the check-in. Please take them again.',
      fields: { photos: 'Take again: dashboard' },
    });
  });
});

describe('check-in timing', () => {
  const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;

  it('answers 409 to the second of two check-ins at the same moment, and deletes its photos', async () => {
    const { booking, guestAgent } = await trip();
    const shots = await photos(guestAgent, booking.ref);
    // The Host's check-in lands between the Guest's own check and its save.
    await ConditionReportModel.create({
      bookingId: booking._id,
      stage: 'CHECK_IN',
      odometer: 45000,
      fuelOrBatteryPct: 80,
    });
    vi.spyOn(ConditionReportModel, 'find').mockReturnValueOnce({ lean: async () => [] } as never);
    const late = await checkIn(guestAgent, booking.ref, shots);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'NOT_CHECK_IN', message: 'Check-in is already done.' });
    // Its photos went with it.
    const name = shots[0]!.key.split('/').at(-1);
    await expect(stat(localFilePath(`bookings/${booking.id}/inspections/${name}`))).rejects.toThrow();
  });

  it('closes at the end time: support sorts out the booking', async () => {
    const { booking, hostAgent } = await trip(
      new Date(Date.now() - 3 * DAY_MS),
      new Date(Date.now() - HOUR_MS),
    );
    const handover = (await hostAgent.get(`/api/v1/bookings/${booking.ref}/inspections`)).body.handover;
    expect(handover.actions.checkIn).toBe(false);
    expect(handover.checkInClosesAt).toBe(booking.endAt.toISOString());
    const shots = await photos(hostAgent, booking.ref);
    const closed = await checkIn(hostAgent, booking.ref, shots);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('CHECK_IN_CLOSED');
    expect(closed.body.error.message).toMatch(/contact support/);
  });

  it('checks a late check-in the Guest never confirms from when it was done', async () => {
    const { booking, guest, hostAgent } = await trip(new Date(Date.now() - 3 * HOUR_MS));
    const id = booking.id as string;
    // The start checks, already run or still queued.
    await enqueue(
      'trip.startCheck',
      { bookingId: id, hoursAfter: 2 },
      { runAt: new Date(Date.now() + HOUR_MS), uniqueKey: `trip.startCheck:2:${id}`, refId: id },
    );
    const shots = await photos(hostAgent, booking.ref);
    expect((await checkIn(hostAgent, booking.ref, shots)).status).toBe(201);

    const jobs = await JobModel.find({ type: 'trip.startCheck', refId: id }).sort({ runAt: 1 }).lean();
    expect(jobs.find((job) => job.uniqueKey === `trip.startCheck:2:${id}`)!.status).toBe('CANCELLED');
    const queued = jobs.filter((job) => job.status === 'QUEUED');
    expect(queued.map((job) => job.uniqueKey)).toEqual([
      `trip.startCheck:1:checked-in:${id}`,
      `trip.startCheck:2:checked-in:${id}`,
    ]);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + HOUR_MS - 60_000);
    expect(queued[1]!.runAt.getTime()).toBeGreaterThan(Date.now() + 2 * HOUR_MS - 60_000);

    await startCheckJob({ bookingId: id, hoursAfter: 1 }, context);
    expect(
      await NotificationModel.findOne({ type: 'CHECK_IN_UNCONFIRMED', userId: guest._id, channel: 'IN_APP' }),
    ).not.toBeNull();
  });

  it('runs the usual start checks for a check-in before the start', async () => {
    const { booking, hostAgent } = await trip();
    const shots = await photos(hostAgent, booking.ref);
    expect((await checkIn(hostAgent, booking.ref, shots)).status).toBe(201);
    expect(await JobModel.countDocuments({ type: 'trip.startCheck', refId: booking.id })).toBe(0);
  });
});
