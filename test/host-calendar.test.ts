import { describe, expect, it } from 'vitest';
import { fromNzWallClock } from '../src/lib/nz-time.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createUser } from './helpers.js';

const HOUR_MS = 60 * 60 * 1000;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** NZ wall-clock times in October 2027, far enough ahead for every block to be current. */
const oct = (day: number, hour = 0) => fromNzWallClock(2027, 10, day, hour);

interface CalendarCar {
  id: string;
  title: string;
  photo: string | null;
  status: string;
  blocks: {
    reason: string;
    note?: string;
    booking?: { ref: string; guestFirstName: string; toAnswer: boolean };
  }[];
}

describe('the calendar across all the Host’s cars (GET /host/calendar)', () => {
  it('lists only their own cars with a calendar, each with its blocks in the range, as each car’s calendar shows them', async () => {
    const host = await createHost();
    const guest = await createUser({ email: 'kiri@example.co.nz', firstName: 'Kiri' });
    const corolla = await createVehicle(host._id);
    const mazda = await createVehicle(host._id, {
      make: 'Mazda',
      model: '3',
      status: 'INACTIVE',
      photos: [],
    });
    // No calendar for a draft or a listing taken down for good, and never another Host's car.
    await createVehicle(host._id, { status: 'DRAFT' });
    await createVehicle(host._id, { status: 'REJECTED' });
    await createVehicle(host._id, { status: 'SUSPENDED' });
    const other = await createHost('mere@example.co.nz');
    const theirs = await createVehicle(other._id);

    const trip = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: corolla._id },
      { startAt: oct(12, 10), endAt: oct(15, 10) },
    );
    const request = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: mazda._id },
      { status: 'PENDING', instantBook: false, startAt: oct(20, 9), endAt: oct(22, 9) },
    );
    await AvailabilityBlockModel.create([
      {
        vehicleId: corolla._id,
        startAt: oct(12, 10),
        endAt: oct(15, 10),
        reason: 'BOOKED',
        bookingId: trip._id,
      },
      {
        vehicleId: corolla._id,
        startAt: oct(15, 10),
        endAt: oct(15, 12),
        reason: 'BUFFER',
        bookingId: trip._id,
      },
      { vehicleId: corolla._id, startAt: oct(5), endAt: oct(7), reason: 'HOST_BLOCK', note: 'Servicing' },
      { vehicleId: corolla._id, startAt: oct(18, 8), endAt: oct(18, 18), reason: 'RECURRING' },
      { vehicleId: mazda._id, startAt: oct(25), endAt: oct(26), reason: 'ADMIN', note: 'Recall check' },
      {
        vehicleId: mazda._id,
        startAt: oct(20, 9),
        endAt: oct(22, 9),
        reason: 'HOLD',
        bookingId: request._id,
        expiresAt: new Date(Date.now() + 24 * HOUR_MS),
      },
      // Outside the range asked for.
      { vehicleId: corolla._id, startAt: oct(2), endAt: oct(3), reason: 'HOST_BLOCK' },
      { vehicleId: theirs._id, startAt: oct(12), endAt: oct(13), reason: 'HOST_BLOCK' },
    ]);

    const agent = await signIn(host.email);
    const response = await agent.get('/api/v1/host/calendar').query({ from: '2027-10-04', to: '2027-11-01' });

    expect(response.status).toBe(200);
    expect(response.body.from).toBe(oct(4).toISOString());
    expect(response.body.to).toBe(fromNzWallClock(2027, 11, 1).toISOString());
    const cars = response.body.vehicles as CalendarCar[];
    // In the order they were added.
    expect(cars.map((car) => [car.id, car.title, car.status])).toEqual([
      [corolla.id, '2021 Toyota Corolla', 'ACTIVE'],
      [mazda.id, '2021 Mazda 3', 'INACTIVE'],
    ]);
    expect(cars[0]!.photo).toBe(corolla.photos[0]!.url);
    expect(cars[1]!.photo).toBeNull();

    expect(cars[0]!.blocks.map((block) => block.reason)).toEqual([
      'HOST_BLOCK',
      'BOOKED',
      'BUFFER',
      'RECURRING',
    ]);
    expect(cars[0]!.blocks[0]).toMatchObject({ note: 'Servicing' });
    expect(cars[0]!.blocks[1]!.booking).toMatchObject({
      ref: trip.ref,
      guestFirstName: 'Kiri',
      toAnswer: false,
    });
    expect(cars[1]!.blocks.map((block) => block.reason)).toEqual(['HOLD', 'ADMIN']);
    // A request waiting for the Host: "Request pending", with the guest's first name.
    expect(cars[1]!.blocks[0]!.booking).toMatchObject({
      ref: request.ref,
      guestFirstName: 'Kiri',
      toAnswer: true,
    });

    // The same blocks as the car's own calendar.
    const own = await agent
      .get(`/api/v1/host/vehicles/${corolla.id}/calendar`)
      .query({ from: '2027-10-04', to: '2027-11-01' });
    expect(cars[0]!.blocks).toEqual(own.body.blocks);
  });

  it('answers a Host with no cars, or a Guest, with none', async () => {
    await createUser({ email: 'kiri@example.co.nz' });
    const agent = await signIn('kiri@example.co.nz');
    const response = await agent.get('/api/v1/host/calendar').query({ from: '2027-10-01', to: '2027-10-15' });
    expect(response.status).toBe(200);
    expect(response.body.vehicles).toEqual([]);
  });

  it('needs two NZ days, the second after the first and at most 62 days later', async () => {
    const host = await createHost();
    const agent = await signIn(host.email);
    const ask = (query: Record<string, string>) => agent.get('/api/v1/host/calendar').query(query);

    const missing = await ask({ from: '2027-10-01' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.fields).toHaveProperty('to');

    const notADay = await ask({ from: '2027-10-01', to: '2027-02-30' });
    expect(notADay.status).toBe(400);

    const backwards = await ask({ from: '2027-10-15', to: '2027-10-15' });
    expect(backwards.body.error.fields.to).toBe('Choose an end after the start');

    const tooLong = await ask({ from: '2027-10-01', to: '2027-12-03' });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.fields.to).toBe('Choose up to 62 days');

    expect((await ask({ from: '2027-10-01', to: '2027-12-02' })).status).toBe(200);
  });

  it('is for signed-in Hosts only', async () => {
    const response = await browserAgent()
      .get('/api/v1/host/calendar')
      .query({ from: '2027-10-01', to: '2027-10-15' });
    expect(response.status).toBe(401);
  });
});
