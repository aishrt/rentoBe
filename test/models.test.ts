import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { point } from '../src/lib/model-fields.js';
import { allModels } from '../src/models.js';
import { DEFAULT_SETTINGS } from '../src/modules/admin/default-settings.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import {
  ensurePlatformSettings,
  getPlatformSettings,
  resolveSettings,
} from '../src/modules/admin/platform-settings.service.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { PlaceModel } from '../src/modules/search/place.model.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';

const id = () => new mongoose.Types.ObjectId();

function validBooking(overrides: Record<string, unknown> = {}) {
  return new BookingModel({
    ref: 'RV-7K2Q9M',
    vehicleId: id(),
    guestId: id(),
    hostId: id(),
    startAt: new Date('2026-11-01T21:00:00Z'),
    endAt: new Date('2026-11-03T21:00:00Z'),
    vehicleSnapshot: { title: '2021 Toyota Corolla' },
    terms: { fuelPolicy: 'SAME_LEVEL', unlimitedKm: true, extraKmCents: 0 },
    price: {
      subtotalCents: 11800,
      deliveryCents: 0,
      serviceFeeCents: 1180,
      protectionCents: 3000,
      gstCents: 2083,
      totalCents: 15980,
      hostPayoutCents: 9440,
      platformFeeCents: 3540,
    },
    ...overrides,
  });
}

describe('indexes', () => {
  it('syncs every collection from the schemas, with the key indexes from plan §3', async () => {
    for (const model of allModels) await model.syncIndexes();

    const keysOf = async (model: (typeof allModels)[number]) =>
      (await model.listIndexes()).map((index) => ({ key: index.key, unique: Boolean(index.unique) }));

    expect(await keysOf(VehicleModel)).toContainEqual({
      key: { location: '2dsphere', status: 1 },
      unique: false,
    });
    expect(await keysOf(VehicleModel)).toContainEqual({ key: { slug: 1 }, unique: true });
    expect(await keysOf(BookingModel)).toContainEqual({ key: { ref: 1 }, unique: true });
    expect(await keysOf(ReviewModel)).toContainEqual({ key: { bookingId: 1, direction: 1 }, unique: true });
    expect(await keysOf(PlaceModel)).toContainEqual({ key: { location: '2dsphere' }, unique: false });

    // Every model has its own collection name, as in plan §3.
    const names = allModels.map((model) => model.collection.collectionName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'availabilityBlocks',
        'conditionReports',
        'supportTickets',
        'platformSettings',
      ]),
    );
  });
});

describe('field rules', () => {
  it('accepts a complete booking', async () => {
    await expect(validBooking().validate()).resolves.toBeUndefined();
  });

  it('refuses money that is not whole cents or is negative', async () => {
    const fractional = validBooking();
    fractional.price.totalCents = 159.8;
    await expect(fractional.validate()).rejects.toThrow(/whole number of cents/);

    const negative = validBooking();
    negative.price.gstCents = -1;
    await expect(negative.validate()).rejects.toThrow(/gstCents/);
  });

  it('lets a discount line be negative, but still whole cents', async () => {
    const discount = { code: 'WEEKLY_DISCOUNT', label: 'Weekly discount', gstCents: -548, mandatory: true };
    await expect(validBooking({ lineItems: [{ ...discount, amountCents: -4200 }] }).validate()).resolves.toBe(
      undefined,
    );
    await expect(
      validBooking({ lineItems: [{ ...discount, amountCents: -42.5 }] }).validate(),
    ).rejects.toThrow();
  });

  it('checks booking references and that a trip ends after it starts', async () => {
    await expect(validBooking({ ref: 'RV-123' }).validate()).rejects.toThrow(/RV-XXXXXX/);
    await expect(validBooking({ endAt: new Date('2026-11-01T20:00:00Z') }).validate()).rejects.toThrow(
      /endAt must be after startAt/,
    );
  });

  it('refuses coordinates that are not [longitude, latitude]', async () => {
    const place = new PlaceModel({
      type: 'CITY',
      name: 'Nowhere',
      region: 'Otago',
      location: point(200, -45),
    });
    await expect(place.validate()).rejects.toThrow(/longitude, latitude/);
  });

  it('stores number plates in capitals without spaces and checks VINs', async () => {
    const vehicle = new VehicleModel({
      hostId: id(),
      slug: 'demo',
      regoPlate: 'abc 123',
      vin: 'JTDBR32E72012345O',
    });
    expect(vehicle.regoPlate).toBe('ABC123');
    // The letter O never appears in a VIN.
    await expect(vehicle.validate()).rejects.toThrow(/vin/);
  });

  it('keeps one review each way per trip', async () => {
    await ReviewModel.init();
    const review = {
      bookingId: id(),
      authorId: id(),
      subjectId: id(),
      direction: 'GUEST_TO_HOST',
      overall: 5,
    };
    await ReviewModel.create(review);
    await expect(ReviewModel.create({ ...review, authorId: id() })).rejects.toThrow(/duplicate key/);
    await expect(ReviewModel.create({ ...review, direction: 'HOST_TO_GUEST' })).resolves.toBeTruthy();
    await expect(ReviewModel.create({ ...review, bookingId: id(), overall: 4.5 })).rejects.toThrow(
      /whole number/,
    );
  });

  it('needs a user or an email address on a support ticket', async () => {
    const ticket = { ref: 'ST-000001', subject: 'Question about my booking', category: 'BOOKING' };
    await expect(new SupportTicketModel(ticket).validate()).rejects.toThrow(/user or an email/);
    await expect(new SupportTicketModel({ ...ticket, email: 'kiri@example.co.nz' }).validate()).resolves.toBe(
      undefined,
    );
  });
});

describe('places', () => {
  it('finds places by a prefix typed without macrons', async () => {
    await PlaceModel.create([
      { type: 'CITY', name: 'Taupō', region: 'Waikato', location: point(176.0702, -38.6857) },
      { type: 'CITY', name: 'Tauranga', region: 'Bay of Plenty', location: point(176.1651, -37.6878) },
      { type: 'CITY', name: 'Whangārei', region: 'Northland', location: point(174.3237, -35.7251) },
    ]);

    const found = await PlaceModel.find({ searchName: mongoose.trusted({ $regex: '^taup' }) });
    expect(found.map((place) => place.name)).toEqual(['Taupō']);
    expect((await PlaceModel.findOne({ name: 'Whangārei' }))?.searchName).toBe('whangarei');
  });
});

describe('vehicles', () => {
  it('finds live cars by distance with $geoNear', async () => {
    await VehicleModel.init();
    const hostId = id();
    await VehicleModel.create([
      { hostId, slug: 'ponsonby', status: 'ACTIVE', location: point(174.744, -36.856) },
      { hostId, slug: 'takapuna', status: 'ACTIVE', location: point(174.772, -36.788) },
      { hostId, slug: 'draft', status: 'DRAFT', location: point(174.765, -36.847) },
      { hostId, slug: 'queenstown', status: 'ACTIVE', location: point(168.6626, -45.0312) },
    ]);

    const nearby = await VehicleModel.aggregate<{ slug: string; distanceKm: number }>([
      {
        $geoNear: {
          near: point(174.7633, -36.8485),
          distanceField: 'distanceKm',
          distanceMultiplier: 0.001,
          maxDistance: 25_000,
          query: { status: 'ACTIVE' },
        },
      },
    ]);

    expect(nearby.map((vehicle) => vehicle.slug)).toEqual(['ponsonby', 'takapuna']);
    expect(nearby[0]!.distanceKm).toBeLessThan(3);
  });
});

describe('platform settings', () => {
  it('has launch defaults that pass their own schema', () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('reads saved values over the defaults, so settings added later still have a value', async () => {
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { fees: { guestServiceFeePct: 12 }, reviews: { windowDays: 10 } },
    });

    const settings = await getPlatformSettings();
    expect(settings.fees.guestServiceFeePct).toBe(12);
    expect(settings.fees.hostCommissionPct).toBe(DEFAULT_SETTINGS.fees.hostCommissionPct);
    expect(settings.reviews).toEqual({ ...DEFAULT_SETTINGS.reviews, windowDays: 10 });
    expect(settings.protectionPlans).toEqual(DEFAULT_SETTINGS.protectionPlans);
  });

  it('refuses invalid saved values', () => {
    expect(() => resolveSettings({ cancellation: { defaultTier: 'NONE' } })).toThrow(/defaultTier/);
    expect(() => resolveSettings({ fees: { gstRatePct: 150 } })).toThrow();
  });

  it('saves the defaults once and never overwrites saved settings', async () => {
    expect(await ensurePlatformSettings()).toBe(true);
    await PlatformSettingsModel.updateOne(
      { _id: PLATFORM_SETTINGS_ID },
      { $set: { 'settings.fees.guestServiceFeePct': 8 } },
    );

    expect(await ensurePlatformSettings()).toBe(false);
    expect((await getPlatformSettings()).fees.guestServiceFeePct).toBe(8);
  });
});
