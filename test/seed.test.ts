import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { seedDemoData, seedReferenceData } from '../scripts/seed-data/index.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { CmsBlockModel } from '../src/modules/cms/cms-block.model.js';
import { DestinationModel } from '../src/modules/cms/destination.model.js';
import { FaqModel } from '../src/modules/help/faq.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { PlaceModel } from '../src/modules/search/place.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';

const PASSWORD = 'demo password for tests';

describe('reference data', () => {
  it('adds only what is missing, so a re-run keeps admins’ edits', async () => {
    const first = await seedReferenceData();
    expect(first.destinations).toBe(5);
    expect(first.cmsBlocks).toBe(5);
    expect(first.platformSettings).toBe(1);

    await FaqModel.updateOne({ order: 1 }, { $set: { answer: 'Edited by an admin' } });
    const second = await seedReferenceData();

    expect(Object.values(second).every((count) => count === 0)).toBe(true);
    expect(await PlaceModel.countDocuments()).toBe(first.places);
    expect((await FaqModel.findOne({ order: 1 }))?.answer).toBe('Edited by an admin');
  });

  it('links suburbs and airports to their city', async () => {
    await seedReferenceData();

    const auckland = await PlaceModel.findOne({ type: 'CITY', name: 'Auckland' });
    const airport = await PlaceModel.findOne({ type: 'AIRPORT', code: 'AKL' });
    expect(airport?.parentId?.equals(auckland!._id)).toBe(true);
    expect(await PlaceModel.countDocuments({ type: 'SUBURB', parentId: auckland!._id })).toBeGreaterThan(5);

    const queenstown = await DestinationModel.findOne({ slug: 'queenstown' });
    expect(queenstown?.airports).toEqual(['ZQN']);
    expect(await PlaceModel.exists({ type: 'AIRPORT', code: 'ZQN' })).toBeTruthy();
    expect((await CmsBlockModel.findOne({ key: 'legal.terms' }))?.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('demo data', () => {
  it('creates 20 live cars with completed trips and reviews, and a re-run resets them', async () => {
    await seedReferenceData();
    const first = await seedDemoData(PASSWORD);
    const second = await seedDemoData(PASSWORD);

    expect(second).toEqual(first);
    expect(await VehicleModel.countDocuments({ status: 'ACTIVE' })).toBe(20);
    expect(await BookingModel.countDocuments({ status: 'COMPLETED' })).toBe(first.bookings);
    expect(await ReviewModel.countDocuments()).toBe(first.bookings * 2);
    expect(await AvailabilityBlockModel.countDocuments({ reason: 'BOOKED' })).toBe(first.bookings);
  });

  it('keeps ratings and trip counts in step with the reviews and bookings', async () => {
    await seedReferenceData();
    await seedDemoData(PASSWORD);

    for (const vehicle of await VehicleModel.find()) {
      const trips = await BookingModel.countDocuments({ vehicleId: vehicle._id, status: 'COMPLETED' });
      expect(vehicle.tripCount).toBe(trips);
      expect(vehicle.rating.count).toBe(trips);
      if (trips > 0) expect(vehicle.rating.avg).toBeGreaterThanOrEqual(4);
    }
    // Some cars have no trips yet, so listings also show the New label.
    expect(await VehicleModel.countDocuments({ tripCount: 0 })).toBeGreaterThan(0);

    const host = await UserModel.findOne({ email: 'host@rentovroom.test' });
    expect(host?.hostProfile?.status).toBe('APPROVED');
    expect(host?.hostProfile?.tripCount).toBe(await BookingModel.countDocuments({ hostId: host!._id }));
  });

  it('dates the reviews after their trips, and its prices add up', async () => {
    await seedReferenceData();
    await seedDemoData(PASSWORD);

    const booking = await BookingModel.findOne().sort({ ref: 1 });
    const review = await ReviewModel.findOne({ bookingId: booking!._id, direction: 'GUEST_TO_HOST' });
    expect(review!.createdAt.getTime()).toBeGreaterThan(booking!.endAt.getTime());
    expect(booking!.endAt.getTime()).toBeLessThan(Date.now());

    const { price, lineItems } = booking!;
    expect(lineItems.reduce((sum, item) => sum + item.amountCents, 0)).toBe(price.totalCents);
    expect(price.hostPayoutCents + price.platformFeeCents).toBe(price.subtotalCents + price.serviceFeeCents);
  });

  it('gives demo accounts the demo password and accepted agreements', async () => {
    await seedDemoData(PASSWORD);

    const guest = await UserModel.findOne({ email: 'guest@rentovroom.test' }).select('+passwordHash');
    expect(await bcrypt.compare(PASSWORD, guest!.passwordHash)).toBe(true);
    expect(guest?.agreements.map((agreement) => agreement.type)).toEqual(['TERMS', 'PRIVACY', 'GUEST']);
  });
});
