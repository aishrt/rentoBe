import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { forget } from '../src/lib/memo.js';
import { parseNzDateTime } from '../src/lib/nz-time.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { DEFAULT_SETTINGS } from '../src/modules/admin/default-settings.js';
import { calculatePrice, defaultProtectionPlan } from '../src/modules/pricing/pricing.js';
import { HAMILTON, QUEENSTOWN, createHost, createPlaces, createVehicle, nzDay } from './fixtures.js';
import { testApp } from './helpers.js';

const app = testApp();
const search = (query: Record<string, string | string[]>) => request(app).get('/api/v1/search').query(query);

beforeEach(() => forget());

describe('Place suggestions', () => {
  beforeEach(createPlaces);

  it('suggests our places by prefix, ignoring macrons, with airports labelled', async () => {
    const response = await request(app).get('/api/v1/places/suggest').query({ q: 'auck' });
    expect(response.status).toBe(200);
    const labels = response.body.suggestions.map((suggestion: { label: string }) => suggestion.label);
    expect(labels.slice(0, 2)).toEqual(['Auckland', 'Auckland Airport (AKL)']);
    expect(labels).toContain('Auckland Central');
    expect(response.body.suggestions[0]).toMatchObject({ type: 'CITY', lat: expect.any(Number) });

    const taupo = await request(app).get('/api/v1/places/suggest').query({ q: 'taupo' });
    expect(taupo.body.suggestions[0].name).toBe('Taupō');

    const code = await request(app).get('/api/v1/places/suggest').query({ q: 'akl' });
    expect(code.body.suggestions[0]).toMatchObject({ type: 'AIRPORT', code: 'AKL' });

    const words = await request(app).get('/api/v1/places/suggest').query({ q: 'central' });
    expect(words.body.suggestions[0]).toMatchObject({
      name: 'Auckland Central',
      secondary: 'Auckland, Auckland',
    });
  });

  it('lists popular places for an empty field and resolves a suggestion', async () => {
    const popular = await request(app).get('/api/v1/places/suggest');
    expect(popular.body.suggestions.map((suggestion: { name: string }) => suggestion.name)).toEqual([
      'Auckland',
      'Queenstown',
      'Auckland Airport',
      'Taupō',
    ]);

    const details = await request(app).get(`/api/v1/places/${popular.body.suggestions[2].id}`);
    expect(details.body.place).toMatchObject({ label: 'Auckland Airport (AKL)', code: 'AKL' });
    expect((await request(app).get('/api/v1/places/google:abc')).status).toBe(404);
  });
});

describe('Search', () => {
  beforeEach(createPlaces);

  it('browses every live car in NZ without a place or dates', async () => {
    const host = await createHost();
    const live = await createVehicle(host._id, { make: 'Mazda', model: 'CX-5' });
    await createVehicle(host._id, { status: 'DRAFT' });
    await createVehicle(host._id, { wofExpiry: new Date(Date.now() - 1000) });
    await createVehicle(host._id, { at: QUEENSTOWN, city: 'Queenstown' });

    const response = await search({});
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.place).toBeNull();
    expect(response.body.dates).toBeNull();
    const card = response.body.results.find((result: { id: string }) => result.id === live.id);
    expect(card).toMatchObject({
      title: '2021 Mazda CX-5',
      distanceKm: null,
      estimate: null,
      dailyCents: 8900,
      instantBook: true,
      rating: { avg: 0, count: 0 },
      photo: { url: expect.stringContaining('front.jpg'), alt: '2021 Mazda CX-5: front' },
    });
    // Never the plate or the address.
    expect(JSON.stringify(response.body)).not.toContain('TST');
    expect(JSON.stringify(response.body)).not.toContain('Ponsonby Road');
  });

  it('searches around a place, with each car’s distance', async () => {
    const host = await createHost();
    await createVehicle(host._id);
    await createVehicle(host._id, { at: QUEENSTOWN, city: 'Queenstown' });

    const response = await search({ where: 'Auckland' });
    expect(response.body.place).toMatchObject({ label: 'Auckland', type: 'CITY' });
    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0].distanceKm).toBeCloseTo(1.9, 0);

    const unknown = await search({ where: 'Atlantis' });
    expect(unknown.body).toMatchObject({ placeNotFound: true, place: null, total: 2 });
  });

  it('finds cars that deliver to a searched airport, with the delivery fee in the estimate', async () => {
    const host = await createHost();
    const near = await createVehicle(host._id);
    const delivers = await createVehicle(host._id, {
      at: HAMILTON,
      deliveryOptions: [
        { type: 'PICKUP', label: 'Hamilton', feeCents: 0 },
        { type: 'AIRPORT', label: 'Auckland Airport', airportCode: 'AKL', feeCents: 6000 },
      ],
    });
    await createVehicle(host._id, { at: HAMILTON });

    const start = nzDay(10);
    const end = nzDay(13);
    const response = await search({ where: 'Auckland Airport (AKL)', start, end });
    expect(response.body.place).toMatchObject({ airportCode: 'AKL' });
    expect(response.body.results.map((card: { id: string }) => card.id).sort()).toEqual(
      [near.id, delivers.id].sort(),
    );

    const airportCard = response.body.results.find((card: { id: string }) => card.id === delivers.id);
    const expected = calculatePrice({
      startAt: parseNzDateTime(start)!,
      endAt: parseNzDateTime(end)!,
      pricing: { dailyCents: 8900, weeklyDiscountPct: 10, monthlyDiscountPct: 20 },
      pickup: { type: 'AIRPORT', label: 'Auckland Airport', feeCents: 6000 },
      dropoff: { type: 'AIRPORT', label: 'Auckland Airport', feeCents: 6000 },
      protectionPlan: defaultProtectionPlan(DEFAULT_SETTINGS.protectionPlans),
      fees: DEFAULT_SETTINGS.fees,
      hostGstRegistered: false,
    });
    expect(airportCard.estimate).toEqual({
      days: 3,
      totalCents: expected.price.totalCents,
      includesAirportDelivery: true,
    });
    const nearCard = response.body.results.find((card: { id: string }) => card.id === near.id);
    expect(nearCard.estimate.includesAirportDelivery).toBe(false);
  });

  it('leaves out cars that are booked, need more notice or longer trips for the dates', async () => {
    const host = await createHost();
    const free = await createVehicle(host._id);
    const booked = await createVehicle(host._id);
    await createVehicle(host._id, {
      rules: { minDays: 5, maxDays: 30, minNoticeHours: 4, bufferHours: 2, instantBook: false },
    });
    await createVehicle(host._id, {
      rules: { minDays: 1, maxDays: 30, minNoticeHours: 24 * 30, bufferHours: 2, instantBook: false },
    });
    await createVehicle(host._id, { regoExpiry: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) });

    const start = nzDay(10);
    const end = nzDay(13);
    await AvailabilityBlockModel.create({
      vehicleId: booked._id,
      startAt: parseNzDateTime(nzDay(12))!,
      endAt: parseNzDateTime(nzDay(15))!,
      reason: 'BOOKED',
    });
    // An expired hold no longer blocks the dates.
    await AvailabilityBlockModel.create({
      vehicleId: free._id,
      startAt: parseNzDateTime(start)!,
      endAt: parseNzDateTime(end)!,
      reason: 'HOLD',
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await search({ start, end });
    expect(response.body.results.map((card: { id: string }) => card.id)).toEqual([free.id]);
    expect(response.body.dates).toMatchObject({ days: 3 });
    expect(response.body.results[0].estimate.days).toBe(3);
  });

  it('applies every filter from spec §5', async () => {
    const host = await createHost();
    const suv = await createVehicle(host._id, {
      make: 'Toyota',
      model: 'RAV4',
      bodyType: 'SUV',
      fuelType: 'PHEV',
      seats: 7,
      year: 2023,
      transmission: 'AUTOMATIC',
      unlimitedKm: true,
      petFriendly: true,
      childSeat: true,
      rating: { avg: 4.9, count: 12 },
      pricing: { dailyCents: 14_000, weeklyDiscountPct: 0, monthlyDiscountPct: 0, extraKmCents: 0 },
      deliveryOptions: [
        { type: 'PICKUP', label: 'Ponsonby', feeCents: 0 },
        { type: 'DELIVERY', label: 'Delivery', feeCents: 3000, radiusKm: 15 },
        { type: 'AIRPORT', label: 'Auckland Airport', airportCode: 'AKL', feeCents: 4500 },
      ],
    });
    const hatch = await createVehicle(host._id, {
      make: 'Suzuki',
      model: 'Swift',
      fuelType: 'PETROL',
      transmission: 'MANUAL',
      year: 2016,
      rules: { minDays: 1, maxDays: 30, minNoticeHours: 4, bufferHours: 2, instantBook: false },
      pricing: { dailyCents: 4_500, weeklyDiscountPct: 0, monthlyDiscountPct: 0, extraKmCents: 0 },
    });

    const only = async (query: Record<string, string | string[]>) =>
      (await search(query)).body.results.map((card: { id: string }) => card.id);

    expect(await only({ types: 'SUV' })).toEqual([suv.id]);
    expect(await only({ types: ['SUV', 'HATCHBACK'] })).toHaveLength(2);
    expect(await only({ make: 'toyota', model: 'rav4' })).toEqual([suv.id]);
    expect(await only({ minYear: '2020' })).toEqual([suv.id]);
    expect(await only({ maxYear: '2018' })).toEqual([hatch.id]);
    expect(await only({ transmission: 'MANUAL' })).toEqual([hatch.id]);
    expect(await only({ minSeats: '6' })).toEqual([suv.id]);
    expect(await only({ fuel: 'PETROL' })).toEqual([hatch.id]);
    expect(await only({ electrified: 'true' })).toEqual([suv.id]);
    expect(await only({ airportDelivery: 'true' })).toEqual([suv.id]);
    expect(await only({ delivery: 'true' })).toEqual([suv.id]);
    expect(await only({ instantBook: 'true' })).toEqual([suv.id]);
    expect(await only({ minRating: '4' })).toEqual([suv.id]);
    expect(await only({ unlimitedKm: 'true' })).toEqual([suv.id]);
    expect(await only({ petFriendly: 'true' })).toEqual([suv.id]);
    expect(await only({ childSeat: 'true' })).toEqual([suv.id]);
    expect(await only({ minDailyCents: '5000' })).toEqual([suv.id]);
    expect(await only({ maxDailyCents: '5000' })).toEqual([hatch.id]);
    // Unknown values are ignored rather than failing the search.
    expect(await only({ types: 'SPACESHIP', transmission: 'WARP', minSeats: 'lots' })).toHaveLength(2);

    expect(await only({ sort: 'price_asc' })).toEqual([hatch.id, suv.id]);
    expect(await only({ sort: 'price_desc' })).toEqual([suv.id, hatch.id]);
    expect(await only({ sort: 'rating' })).toEqual([suv.id, hatch.id]);

    const card = (await search({ types: 'SUV' })).body.results[0];
    expect(card).toMatchObject({
      delivery: true,
      airportDelivery: true,
      features: ['Unlimited kilometres', 'Child seat available', 'Pet friendly'],
    });
  });

  it('pages results', async () => {
    const host = await createHost();
    for (let index = 0; index < 5; index += 1) await createVehicle(host._id);
    const first = await search({ pageSize: '2' });
    const third = await search({ pageSize: '2', page: '3' });
    expect(first.body).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(first.body.results).toHaveLength(2);
    expect(third.body.results).toHaveLength(1);
  });

  it('checks dates and ranges', async () => {
    const past = await search({ start: '2020-01-01T10:00', end: '2020-01-03T10:00' });
    expect(past.status).toBe(400);
    expect(past.body.error.fields.start).toBe('Pick-up needs to be in the future');

    const backwards = await search({ start: nzDay(5), end: nzDay(3) });
    expect(backwards.body.error.fields.end).toBe('Return needs to be after pick-up');

    const tooLong = await search({ start: nzDay(5), end: nzDay(200) });
    expect(tooLong.body.error.fields.end).toBe('Trips can be up to 90 days long');

    const prices = await search({ minDailyCents: '9000', maxDailyCents: '5000' });
    expect(prices.body.error.fields.minDailyCents).toBeDefined();
  });

  it('lists makes and models of live cars', async () => {
    const host = await createHost();
    await createVehicle(host._id, { make: 'Toyota', model: 'RAV4' });
    await createVehicle(host._id, { make: 'Toyota', model: 'Corolla' });
    await createVehicle(host._id, { make: 'BMW', model: 'i3', status: 'DRAFT' });
    const response = await request(app).get('/api/v1/search/makes');
    expect(response.body.makes).toEqual([{ make: 'Toyota', models: ['Corolla', 'RAV4'] }]);
  });
});
