import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * What staff see when they review a car (plan §3, changes to live listings; §8.2, vehicle suspended): the key
 * details a Host changed on a live listing, and a suspended car's upcoming bookings, each time the page loads.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

describe('key details changed on a live listing', () => {
  it('keeps what changed, from the live value to the latest, until staff approve or reject it', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, { regoPlate: 'ABC123', make: 'Toyota', year: 2021 });
    const hostAgent = await signIn('hana@example.co.nz');
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const staff = await staffAgent('sam@example.co.nz');
    const edit = (patch: Record<string, unknown>) =>
      hostAgent.patch(`/api/v1/host/vehicles/${vehicle.id}`).send(patch);
    const review = async () => (await staff.get(`/api/v1/admin/vehicles/${vehicle.id}`)).body;

    // A live listing with nothing changed has nothing to compare.
    expect((await review()).keyChanges).toEqual([]);

    const plate = await edit({ regoPlate: 'XYZ 789' });
    expect(plate.body.vehicle.status).toBe('UNDER_REVIEW');
    expect((await review()).keyChanges).toEqual([
      { field: 'regoPlate', before: 'ABC123', after: 'XYZ789', changedAt: expect.any(String) },
    ]);

    // Edits before the review add to it: the plate keeps its live value, and the year is new.
    await edit({ regoPlate: 'QRS456', year: 2022 });
    expect((await review()).keyChanges).toEqual([
      { field: 'regoPlate', before: 'ABC123', after: 'QRS456', changedAt: expect.any(String) },
      { field: 'year', before: '2021', after: '2022', changedAt: expect.any(String) },
    ]);
    // A detail put back as it was drops out; other edits leave the list alone.
    await edit({ year: 2021, seats: 4 });
    expect((await review()).keyChanges.map((change: { field: string }) => change.field)).toEqual([
      'regoPlate',
    ]);

    const queue = await staff.get('/api/v1/admin/vehicles');
    expect(queue.body.vehicles).toEqual([
      expect.objectContaining({ id: vehicle.id, status: 'UNDER_REVIEW', keyChanges: ['regoPlate'] }),
    ]);

    // Asking for changes keeps them for the next look, and the Host's next edits still count.
    const changes = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/request-changes`)
      .send({ notes: 'Please upload the new registration papers.' });
    expect(changes.status).toBe(200);
    await edit({ make: 'Honda' });
    expect((await review()).keyChanges.map((change: { field: string }) => change.field)).toEqual([
      'regoPlate',
      'make',
    ]);

    await VehicleModel.updateOne({ _id: vehicle._id }, { $set: { status: 'UNDER_REVIEW' } });
    const approved = await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/approve`).send({});
    expect(approved.body.vehicle.status).toBe('ACTIVE');
    expect((await review()).keyChanges).toEqual([]);
    expect((await VehicleModel.findById(vehicle._id).lean())!.keyChanges).toBeUndefined();
    expect((await staff.get('/api/v1/admin/vehicles')).body.vehicles).toEqual([]);
    // What was approved stays in the audit log.
    const decision = await AuditLogModel.findOne({ action: 'vehicle.approved', entityId: vehicle.id }).lean();
    expect(decision!.before).toMatchObject({
      status: 'UNDER_REVIEW',
      keyChanges: [
        { field: 'regoPlate', before: 'ABC123', after: 'QRS456' },
        { field: 'make', before: 'Toyota', after: 'Honda' },
      ],
    });

    // Live again: a new change starts a new list, and a rejection clears it too.
    await edit({ model: 'Civic' });
    expect((await review()).keyChanges).toEqual([
      { field: 'model', before: 'Corolla', after: 'Civic', changedAt: expect.any(String) },
    ]);
    await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/reject`).send({ notes: 'Not the same car.' });
    expect((await review()).keyChanges).toEqual([]);
  });

  it('leaves a new listing’s first review without a list of changes', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, { status: 'UNDER_REVIEW' });
    const hostAgent = await signIn('hana@example.co.nz');
    await hostAgent.patch(`/api/v1/host/vehicles/${vehicle.id}`).send({ regoPlate: 'NEW111' });
    await createStaff();
    const staff = await staffAgent();
    expect((await staff.get(`/api/v1/admin/vehicles/${vehicle.id}`)).body.keyChanges).toEqual([]);
    expect((await staff.get('/api/v1/admin/vehicles')).body.vehicles[0].keyChanges).toEqual([]);
  });
});

describe('a suspended car', () => {
  it('lists its upcoming bookings on its page for as long as it’s suspended', async () => {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    const soon = new Date(Date.now() + 2 * DAY_MS);
    const confirmed = await createBookingRecord(parties, { startAt: new Date(Date.now() + 10 * DAY_MS) });
    const request = await createBookingRecord(parties, { status: 'PENDING', startAt: soon });
    const current = await createBookingRecord(parties, {
      status: 'ACTIVE',
      startAt: new Date(Date.now() - DAY_MS),
      endAt: new Date(Date.now() + DAY_MS),
    });
    // Not the car's commitments: an unpaid checkout, a cancelled booking and a finished trip.
    await createBookingRecord(parties, { status: 'PAYMENT_PENDING', startAt: soon });
    await createBookingRecord(parties, { status: 'CANCELLED', startAt: soon });
    await createBookingRecord(parties, {
      status: 'COMPLETED',
      startAt: new Date(Date.now() - 9 * DAY_MS),
      endAt: new Date(Date.now() - 6 * DAY_MS),
    });
    await createStaff();
    const staff = await staffAgent();
    const page = async () => (await staff.get(`/api/v1/admin/vehicles/${vehicle.id}`)).body;

    expect((await page()).upcomingBookings).toBeUndefined();
    const suspended = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/suspend`)
      .send({ reason: 'Rego plate does not match' });
    expect(suspended.status).toBe(200);

    // Opened again later, the page still has them, soonest first.
    const later = await page();
    expect(later.vehicle.status).toBe('SUSPENDED');
    expect(later.upcomingBookings.map((booking: { ref: string }) => booking.ref)).toEqual([
      current.ref,
      request.ref,
      confirmed.ref,
    ]);
    expect(later.upcomingBookings[1]).toMatchObject({ status: 'PENDING', guest: { name: 'Kiri Tester' } });

    await staff.post(`/api/v1/admin/vehicles/${vehicle.id}/unsuspend`);
    expect((await page()).upcomingBookings).toBeUndefined();
  });
});
