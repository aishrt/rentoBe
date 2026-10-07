import type { Types } from 'mongoose';
import { point } from '../src/lib/model-fields.js';
import { BookingModel, type Booking } from '../src/modules/bookings/booking.model.js';
import { PaymentModel, type Payment } from '../src/modules/payments/payment.model.js';
import { PlaceModel } from '../src/modules/search/place.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel, type Vehicle } from '../src/modules/vehicles/vehicle.model.js';
import { createUser } from './helpers.js';

/*
 * Test data for listings, search and bookings: an approved Host, live cars in Auckland and
 * Queenstown, and the handful of NZ places the tests search for.
 */

export const AUCKLAND = { lng: 174.7633, lat: -36.8485 };
export const PONSONBY = { lng: 174.7445, lat: -36.8566 };
export const AKL_AIRPORT = { lng: 174.785, lat: -37.0082 };
export const HAMILTON = { lng: 175.2793, lat: -37.787 };
export const QUEENSTOWN = { lng: 168.6626, lat: -45.0312 };

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createPlaces() {
  const auckland = await PlaceModel.create({
    type: 'CITY',
    name: 'Auckland',
    region: 'Auckland',
    location: point(AUCKLAND.lng, AUCKLAND.lat),
    popularity: 100,
  });
  await PlaceModel.create([
    {
      type: 'AIRPORT',
      name: 'Auckland Airport',
      code: 'AKL',
      region: 'Auckland',
      location: point(AKL_AIRPORT.lng, AKL_AIRPORT.lat),
      parentId: auckland._id,
      popularity: 90,
    },
    {
      type: 'SUBURB',
      name: 'Ponsonby',
      region: 'Auckland',
      location: point(PONSONBY.lng, PONSONBY.lat),
      parentId: auckland._id,
      popularity: 50,
    },
    {
      type: 'SUBURB',
      name: 'Auckland Central',
      region: 'Auckland',
      location: point(AUCKLAND.lng, AUCKLAND.lat),
      parentId: auckland._id,
      popularity: 40,
    },
    { type: 'CITY', name: 'Taupō', region: 'Waikato', location: point(176.0702, -38.6857), popularity: 60 },
    {
      type: 'CITY',
      name: 'Queenstown',
      region: 'Otago',
      location: point(QUEENSTOWN.lng, QUEENSTOWN.lat),
      popularity: 95,
    },
  ]);
}

export async function createHost(email = 'hana@example.co.nz') {
  const host = await createUser({ email, firstName: 'Hana', roles: ['GUEST', 'HOST'] });
  await UserModel.updateOne(
    { _id: host._id },
    {
      $set: {
        hostProfile: {
          status: 'APPROVED',
          appliedAt: new Date(),
          payoutsEnabled: false,
          tripCount: 3,
          rating: { avg: 4.8, count: 3 },
          feesOwedCents: 0,
          gstRegistered: false,
          responseRate: 100,
        },
      },
    },
  );
  return host;
}

let plateNumber = 0;

/** A live, bookable car. Everything can be overridden. */
export async function createVehicle(
  hostId: Types.ObjectId,
  overrides: Partial<Vehicle> & { at?: { lng: number; lat: number } } = {},
) {
  const { at = PONSONBY, ...rest } = overrides;
  plateNumber += 1;
  const make = rest.make ?? 'Toyota';
  const model = rest.model ?? 'Corolla';
  const now = Date.now();
  return VehicleModel.create({
    hostId,
    slug: `${make}-${model}-${plateNumber}`.toLowerCase(),
    regoPlate: `TST${String(plateNumber).padStart(3, '0')}`,
    vin: `RVTEST${String(plateNumber).padStart(11, '0')}`,
    make,
    model,
    year: 2021,
    variant: 'GX',
    transmission: 'AUTOMATIC',
    bodyType: 'HATCHBACK',
    fuelType: 'HYBRID',
    seats: 5,
    doors: 5,
    features: ['Apple CarPlay', 'Reversing camera'],
    wofExpiry: new Date(now + 200 * DAY_MS),
    regoExpiry: new Date(now + 300 * DAY_MS),
    fuelPolicy: 'SAME_LEVEL',
    kmAllowancePerDay: 250,
    unlimitedKm: false,
    pricing: { dailyCents: 8900, weeklyDiscountPct: 10, monthlyDiscountPct: 20, extraKmCents: 35 },
    rules: {
      minDays: 1,
      maxDays: 30,
      minNoticeHours: 4,
      bufferHours: 2,
      instantBook: true,
      cancellationTier: 'MODERATE',
    },
    status: 'ACTIVE',
    onboardingStep: 6,
    location: point(at.lng, at.lat),
    suburb: 'Ponsonby',
    city: 'Auckland',
    region: 'Auckland',
    rating: { avg: 0, count: 0 },
    tripCount: 0,
    photos: ['FRONT', 'REAR', 'INTERIOR'].map((type, order) => ({
      type,
      url: `https://img.example.com/${plateNumber}/${type.toLowerCase()}.jpg`,
      order,
      status: 'APPROVED',
    })),
    deliveryOptions: [
      {
        type: 'PICKUP',
        label: 'Ponsonby',
        feeCents: 0,
        address: {
          streetNumber: '1',
          street: 'Ponsonby Road',
          suburb: 'Ponsonby',
          city: 'Auckland',
          region: 'Auckland',
          postcode: '1011',
          location: point(at.lng, at.lat),
        },
        instructions: 'Parked out the front.',
      },
    ],
    ...rest,
  });
}

let bookingNumber = 0;

/**
 * A confirmed 3-day booking written straight to the database, for features that start after checkout
 * (trips, receipts, handover, reviews, payouts). Its price is a real one: 3 days at $89 with the 10 %
 * service fee and the $15 Basic plan, GST included.
 */
export async function createBookingRecord(
  parties: { guestId: Types.ObjectId; hostId: Types.ObjectId; vehicleId: Types.ObjectId },
  overrides: Partial<Booking> = {},
) {
  bookingNumber += 1;
  const startAt = overrides.startAt ?? new Date(Date.now() + 10 * DAY_MS);
  const endAt = overrides.endAt ?? new Date(startAt.getTime() + 3 * DAY_MS);
  const createdAt = new Date(Date.now() - DAY_MS);
  return BookingModel.create({
    ref: `RV-T${String(bookingNumber).padStart(5, '0')}`,
    ...parties,
    startAt,
    endAt,
    status: 'CONFIRMED',
    instantBook: true,
    vehicleSnapshot: { title: '2021 Toyota Corolla', regoPlate: 'TST001' },
    terms: { fuelPolicy: 'SAME_LEVEL', kmAllowancePerDay: 250, unlimitedKm: false, extraKmCents: 35 },
    price: {
      subtotalCents: 26700,
      deliveryCents: 0,
      serviceFeeCents: 2670,
      protectionCents: 4500,
      gstCents: 4418,
      totalCents: 33870,
      hostPayoutCents: 21360,
      platformFeeCents: 8010,
    },
    lineItems: [
      { code: 'RENTAL', label: '3 days × $89', amountCents: 26700, gstCents: 3483, mandatory: true },
      { code: 'SERVICE_FEE', label: 'Service fee', amountCents: 2670, gstCents: 348, mandatory: true },
      { code: 'PROTECTION', label: 'Basic protection', amountCents: 4500, gstCents: 587, mandatory: true },
    ],
    cancellationPolicy: 'MODERATE',
    statusHistory: [
      { status: 'PAYMENT_PENDING', at: createdAt, by: parties.guestId },
      { status: 'CONFIRMED', at: new Date(createdAt.getTime() + 60_000) },
    ],
    ...overrides,
  });
}

/** The booking's payment, as Stripe left it once paid. */
export async function createPaymentRecord(
  booking: { _id: Types.ObjectId; price: { totalCents: number } },
  overrides: Partial<Payment> = {},
) {
  return PaymentModel.create({
    bookingId: booking._id,
    type: 'BOOKING',
    stripePaymentIntentId: `pi_test_${booking._id.toString()}_${Math.random().toString(36).slice(2, 8)}`,
    amountCents: booking.price.totalCents,
    status: 'SUCCEEDED',
    method: 'Visa ending 4242',
    ...overrides,
  });
}

/** "2026-10-12T10:00"-style NZ times a number of days from now, at 10 am. */
export function nzDay(daysFromNow: number, time = '10:00'): string {
  const date = new Date(Date.now() + daysFromNow * DAY_MS);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(date);
  return `${day}T${time}`;
}
