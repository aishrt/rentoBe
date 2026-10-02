import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { forget } from '../src/lib/memo.js';
import { parseNzDateTime } from '../src/lib/nz-time.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { createHost, createVehicle, nzDay } from './fixtures.js';
import { FRONTEND_ORIGIN, createUser, testApp } from './helpers.js';

const app = testApp();
const DAY_MS = 24 * 60 * 60 * 1000;
const quote = (id: string, body: object) =>
  request(app).post(`/api/v1/vehicles/${id}/quote`).set('Origin', FRONTEND_ORIGIN).send(body);

beforeEach(() => forget());

describe('Vehicle listing', () => {
  it('shows a live listing without its plate, address or pending photos', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, {
      fuelType: 'DIESEL',
      rucValidToKm: 80_000,
      photos: [
        {
          type: 'REAR',
          url: 'https://img.example.com/rear.jpg',
          order: 1,
          qualityFlag: 'OK',
          status: 'APPROVED',
        },
        {
          type: 'FRONT',
          url: 'https://img.example.com/front.jpg',
          order: 0,
          qualityFlag: 'OK',
          status: 'APPROVED',
        },
        {
          type: 'BOOT',
          url: 'https://img.example.com/new.jpg',
          order: 2,
          qualityFlag: 'OK',
          status: 'PENDING',
        },
      ],
    });

    const response = await request(app).get(`/api/v1/vehicles/${vehicle.slug}`);
    expect(response.status).toBe(200);
    const detail = response.body.vehicle;
    expect(detail).toMatchObject({
      id: vehicle.id,
      title: '2021 Toyota Corolla',
      cancellationTier: { code: 'MODERATE' },
      compliance: {
        rego: { status: 'CURRENT', expiresMonth: expect.stringMatching(/^\d{4}-\d{2}$/) },
        inspection: { kind: 'WOF', status: 'CURRENT' },
        ruc: { required: true, recorded: true },
      },
      location: { suburb: 'Ponsonby', city: 'Auckland', approx: { radiusM: 1000 } },
      deliveryOptions: [{ type: 'PICKUP', feeCents: 0, area: 'Ponsonby, Auckland' }],
      host: { firstName: 'Hana', rating: { avg: 4.8, count: 3 }, tripCount: 3, verified: false },
    });
    expect(detail.photos.map((photo: { type: string }) => photo.type)).toEqual(['FRONT', 'REAR']);
    expect(detail.protectionPlans.map((plan: { code: string }) => plan.code)).toEqual([
      'BASIC',
      'STANDARD',
      'PREMIUM',
    ]);
    const body = JSON.stringify(response.body);
    for (const secret of [vehicle.regoPlate!, 'Ponsonby Road', 'Parked out the front', 'kiri@', 'hana@']) {
      expect(body).not.toContain(secret);
    }
    // The map circle's centre is near the car but not on it.
    const [lng, lat] = vehicle.location!.coordinates;
    expect(
      Math.abs(detail.location.approx.lat - lat) + Math.abs(detail.location.approx.lng - lng),
    ).toBeGreaterThan(0.001);
    expect(Math.abs(detail.location.approx.lat - lat)).toBeLessThan(0.005);
  });

  it('is a 404 for drafts, suspended cars and unknown ones', async () => {
    const host = await createHost();
    const draft = await createVehicle(host._id, { status: 'DRAFT' });
    expect((await request(app).get(`/api/v1/vehicles/${draft.slug}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/vehicles/no-such-car')).status).toBe(404);
    expect((await request(app).get(`/api/v1/vehicles/${draft.id}/availability`)).status).toBe(404);
  });

  it('features the best-rated live cars', async () => {
    const host = await createHost();
    await createVehicle(host._id, { model: 'Aqua', rating: { avg: 4.2, count: 4 } });
    await createVehicle(host._id, { model: 'Prius', rating: { avg: 4.9, count: 8 } });
    await createVehicle(host._id, { model: 'Hidden', status: 'INACTIVE', rating: { avg: 5, count: 9 } });
    // Search leaves out cars whose WOF or rego has run out, so the homepage does too.
    await createVehicle(host._id, {
      model: 'Lapsed',
      wofExpiry: new Date(Date.now() - DAY_MS),
      rating: { avg: 5, count: 9 },
    });
    await createVehicle(host._id, {
      model: 'Unregistered',
      regoExpiry: new Date(Date.now() - DAY_MS),
      rating: { avg: 5, count: 9 },
    });
    const response = await request(app).get('/api/v1/vehicles/featured');
    expect(response.body.vehicles.map((card: { model: string }) => card.model)).toEqual(['Prius', 'Aqua']);
  });

  it('shows when the car is busy, merged and without reasons', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const start = parseNzDateTime(nzDay(5))!;
    await AvailabilityBlockModel.create([
      { vehicleId: vehicle._id, startAt: start, endAt: new Date(start.getTime() + DAY_MS), reason: 'BOOKED' },
      {
        vehicleId: vehicle._id,
        startAt: new Date(start.getTime() + DAY_MS),
        endAt: new Date(start.getTime() + DAY_MS + 2 * 3600_000),
        reason: 'BUFFER',
      },
      {
        vehicleId: vehicle._id,
        startAt: new Date(start.getTime() + 3 * DAY_MS),
        endAt: new Date(start.getTime() + 4 * DAY_MS),
        reason: 'HOST_BLOCK',
      },
    ]);

    const response = await request(app).get(`/api/v1/vehicles/${vehicle.id}/availability`);
    expect(response.body.busy).toEqual([
      { start: start.toISOString(), end: new Date(start.getTime() + DAY_MS + 2 * 3600_000).toISOString() },
      {
        start: new Date(start.getTime() + 3 * DAY_MS).toISOString(),
        end: new Date(start.getTime() + 4 * DAY_MS).toISOString(),
      },
    ]);
    expect(response.body).toMatchObject({ minNoticeHours: 4, bufferHours: 2, minDays: 1 });
    expect(JSON.stringify(response.body)).not.toContain('HOST_BLOCK');
  });

  it('lists published guest reviews with category averages', async () => {
    const host = await createHost();
    const guest = await createUser({ firstName: 'Kiri' });
    const vehicle = await createVehicle(host._id, { rating: { avg: 5, count: 1 } });
    const review = (overrides: object) => ({
      bookingId: new mongoose.Types.ObjectId(),
      vehicleId: vehicle._id,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      overall: 5,
      cleanliness: 4,
      communication: 5,
      pickupReturn: 5,
      body: 'Spotless car.',
      status: 'PUBLISHED',
      ...overrides,
    });
    await ReviewModel.create([
      review({}),
      review({ status: 'AWAITING_REVEAL', body: 'Not yet' }),
      review({ moderation: { state: 'HIDDEN' }, body: 'Hidden' }),
    ]);

    const response = await request(app).get(`/api/v1/vehicles/${vehicle.id}/reviews`);
    expect(response.body).toMatchObject({
      total: 1,
      reviews: [{ author: { firstName: 'Kiri' }, overall: 5, body: 'Spotless car.' }],
      categories: { cleanliness: 4, communication: 5, pickupReturn: 5 },
    });
  });
});

describe('Quote', () => {
  it('prices chosen dates, delivery and protection', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, {
      deliveryOptions: [
        { type: 'PICKUP', label: 'Ponsonby', feeCents: 0 },
        { type: 'AIRPORT', label: 'Auckland Airport', airportCode: 'AKL', feeCents: 4500 },
        { type: 'DELIVERY', label: 'Delivery around Auckland', feeCents: 3000, radiusKm: 10 },
      ],
    });
    const airport = vehicle.deliveryOptions[1]!._id!.toString();

    const response = await quote(vehicle.id, {
      start: nzDay(10),
      end: nzDay(12),
      pickupOptionId: airport,
      protectionPlanCode: 'STANDARD',
    });
    expect(response.status).toBe(200);
    expect(response.body.quote).toMatchObject({
      available: true,
      problems: [],
      days: 2,
      instantBook: true,
      protectionPlan: { code: 'STANDARD' },
      pickup: { type: 'AIRPORT', feeCents: 4500 },
      dropoff: { type: 'AIRPORT', feeCents: 4500 },
      price: { subtotalCents: 17_800, serviceFeeCents: 1_780, protectionCents: 5_800, deliveryCents: 9_000 },
    });
    const { price } = response.body.quote;
    expect(price.mandatoryCents + price.optionalCents).toBe(price.totalCents);
    expect(price.mandatoryCents).toBe(17_800 + 1_780);
  });

  it('lists what stands in the way, and still shows the price', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id, {
      regoExpiry: new Date(Date.now() + 11 * DAY_MS),
      deliveryOptions: [
        { type: 'PICKUP', label: 'Ponsonby', feeCents: 0 },
        { type: 'DELIVERY', label: 'Delivery around Auckland', feeCents: 3000, radiusKm: 10 },
      ],
    });
    await AvailabilityBlockModel.create({
      vehicleId: vehicle._id,
      startAt: parseNzDateTime(nzDay(12, '09:00'))!,
      endAt: parseNzDateTime(nzDay(12, '18:00'))!,
      reason: 'HOST_BLOCK',
    });

    const response = await quote(vehicle.id, {
      start: nzDay(1),
      end: nzDay(13),
      pickupOptionId: vehicle.deliveryOptions[1]!._id!.toString(),
      deliveryAddress: {
        street: 'Main Road',
        city: 'Hamilton',
        region: 'Waikato',
        postcode: '3204',
        lat: -37.787,
        lng: 175.2793,
      },
      protectionPlanCode: 'GOLD',
    });
    const codes = response.body.quote.problems.map((problem: { code: string }) => problem.code).sort();
    expect(codes).toEqual([
      'DATES_UNAVAILABLE',
      'DOCUMENTS_EXPIRE',
      'OUTSIDE_DELIVERY_AREA',
      'PLAN_NOT_FOUND',
    ]);
    expect(response.body.quote.available).toBe(false);
    expect(response.body.quote.price.totalCents).toBeGreaterThan(0);

    const noAddress = await quote(vehicle.id, {
      start: nzDay(3),
      end: nzDay(4),
      pickupOptionId: vehicle.deliveryOptions[1]!._id!.toString(),
    });
    expect(noAddress.body.quote.problems).toEqual([expect.objectContaining({ code: 'ADDRESS_NEEDED' })]);

    const soon = await quote(vehicle.id, { start: nzDay(0, '23:59'), end: nzDay(1, '23:59') });
    const notice = new Date(parseNzDateTime(nzDay(0, '23:59'))!).getTime() - Date.now() < 4 * 3600_000;
    expect(
      soon.body.quote.problems.some((problem: { code: string }) => problem.code === 'NOTICE_TOO_SHORT'),
    ).toBe(notice);
  });

  it('refuses dates that make no sense', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const backwards = await quote(vehicle.id, { start: nzDay(5), end: nzDay(4) });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.fields.end).toBe('Return needs to be after pick-up');
  });
});
