/**
 * Generates synthetic vehicles for k6 load testing (plan §9 Day 26, spec §25, §31).
 * Seeds up to 10,000 synthetic vehicles with realistic NZ coordinates, pricing,
 * specs, and availability blocks.
 *
 * Usage:
 *   npx tsx scripts/seed-load-test.ts [--count=10000] [--clean]
 *
 * Safety: refuses to run in production or against live Stripe keys.
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { point, type NzRegion } from '../src/lib/model-fields.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel, type Vehicle } from '../src/modules/vehicles/vehicle.model.js';

if (env.NODE_ENV === 'production' || env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  throw new Error('Load test synthetic seeding is strictly for non-production environments.');
}

const args = process.argv.slice(2);
const cleanOnly = args.includes('--clean');
const countArg = args.find((arg) => arg.startsWith('--count='));
const TOTAL_COUNT = countArg ? parseInt(countArg.split('=')[1]!, 10) : 10_000;

interface RegionHub {
  city: string;
  suburb: string;
  region: NzRegion;
  lat: number;
  lng: number;
  postcode: string;
}

const HUBS: RegionHub[] = [
  { city: 'Auckland', suburb: 'Ponsonby', region: 'Auckland', lat: -36.8535, lng: 174.7447, postcode: '1011' },
  { city: 'Auckland', suburb: 'Newmarket', region: 'Auckland', lat: -36.8688, lng: 174.7774, postcode: '1023' },
  { city: 'Auckland', suburb: 'Takapuna', region: 'Auckland', lat: -36.788, lng: 174.773, postcode: '0622' },
  { city: 'Wellington', suburb: 'Te Aro', region: 'Wellington', lat: -41.2924, lng: 174.773, postcode: '6011' },
  { city: 'Wellington', suburb: 'Newtown', region: 'Wellington', lat: -41.3128, lng: 174.7787, postcode: '6021' },
  { city: 'Christchurch', suburb: 'Christchurch Central', region: 'Canterbury', lat: -43.5321, lng: 172.6362, postcode: '8011' },
  { city: 'Christchurch', suburb: 'Riccarton', region: 'Canterbury', lat: -43.5309, lng: 172.5938, postcode: '8041' },
  { city: 'Queenstown', suburb: 'Queenstown Central', region: 'Otago', lat: -45.0312, lng: 168.6626, postcode: '9300' },
  { city: 'Queenstown', suburb: 'Frankton', region: 'Otago', lat: -45.0211, lng: 168.7368, postcode: '9300' },
  { city: 'Rotorua', suburb: 'Rotorua Central', region: 'Bay of Plenty', lat: -38.1368, lng: 176.2497, postcode: '3010' },
  { city: 'Hamilton', suburb: 'Hamilton Central', region: 'Waikato', lat: -37.787, lng: 175.2793, postcode: '3204' },
  { city: 'Tauranga', suburb: 'Mount Maunganui', region: 'Bay of Plenty', lat: -37.6439, lng: 176.1852, postcode: '3116' },
  { city: 'Dunedin', suburb: 'Dunedin Central', region: 'Otago', lat: -45.8788, lng: 170.5028, postcode: '9016' },
  { city: 'Napier', suburb: 'Napier South', region: "Hawke's Bay", lat: -39.5107, lng: 176.9032, postcode: '4110' },
  { city: 'Nelson', suburb: 'Nelson Central', region: 'Nelson', lat: -41.2706, lng: 173.284, postcode: '7010' },
];

const CAR_TEMPLATES = [
  { make: 'Toyota', model: 'Corolla', bodyType: 'HATCHBACK', fuelType: 'HYBRID', seats: 5, dailyDollars: 85 },
  { make: 'Toyota', model: 'RAV4', bodyType: 'SUV', fuelType: 'HYBRID', seats: 5, dailyDollars: 135 },
  { make: 'Tesla', model: 'Model 3', bodyType: 'SEDAN', fuelType: 'EV', seats: 5, dailyDollars: 145 },
  { make: 'Tesla', model: 'Model Y', bodyType: 'SUV', fuelType: 'EV', seats: 5, dailyDollars: 165 },
  { make: 'Nissan', model: 'Leaf', bodyType: 'HATCHBACK', fuelType: 'EV', seats: 5, dailyDollars: 65 },
  { make: 'Mazda', model: 'CX-5', bodyType: 'SUV', fuelType: 'PETROL', seats: 5, dailyDollars: 110 },
  { make: 'Ford', model: 'Ranger', bodyType: 'UTE', fuelType: 'DIESEL', seats: 5, dailyDollars: 155 },
  { make: 'Hyundai', model: 'Ioniq 5', bodyType: 'SUV', fuelType: 'EV', seats: 5, dailyDollars: 150 },
  { make: 'Kia', model: 'Carnival', bodyType: 'PEOPLE_MOVER', fuelType: 'DIESEL', seats: 8, dailyDollars: 170 },
  { make: 'BMW', model: '330e', bodyType: 'SEDAN', fuelType: 'PHEV', seats: 5, dailyDollars: 175 },
  { make: 'Mercedes-Benz', model: 'C-Class', bodyType: 'SEDAN', fuelType: 'PETROL', seats: 5, dailyDollars: 195 },
  { make: 'Porsche', model: 'Macan', bodyType: 'SUV', fuelType: 'PETROL', seats: 5, dailyDollars: 260 },
] as const;

await connectDb();

try {
  if (cleanOnly) {
    console.log('Cleaning up existing synthetic vehicles...');
    const result = await VehicleModel.deleteMany({ slug: /^synth-/ });
    console.log(`Deleted ${result.deletedCount} synthetic vehicles.`);
    process.exit(0);
  }

  // Ensure a synthetic host exists
  let host = await UserModel.findOne({ email: 'synth.host@rentovroom.test' });
  if (!host) {
    host = await UserModel.create({
      email: 'synth.host@rentovroom.test',
      phone: '+64219998888',
      firstName: 'Synthetic',
      lastName: 'Host',
      passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqr',
      roles: ['HOST'],
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      hostProfile: {
        status: 'APPROVED',
        appliedAt: new Date(),
        payoutsEnabled: true,
        stripeAccountId: 'acct_synth_loadtest',
        bio: 'Synthetic host account for load testing.',
        tripCount: 150,
        rating: { avg: 4.95, count: 85 },
      },
    });
    console.log('Created synthetic host user.');
  }

  console.log(`Starting synthetic vehicle generation (Target: ${TOTAL_COUNT})...`);

  // First, clean up previous synthetic run
  await VehicleModel.deleteMany({ slug: /^synth-/ });

  const BATCH_SIZE = 500;
  let created = 0;
  const now = new Date();
  const futureYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  while (created < TOTAL_COUNT) {
    const batchCount = Math.min(BATCH_SIZE, TOTAL_COUNT - created);
    const vehicles: Partial<Vehicle>[] = [];

    for (let i = 0; i < batchCount; i += 1) {
      const index = created + i + 1;
      const hub = HUBS[index % HUBS.length]!;
      const tpl = CAR_TEMPLATES[index % CAR_TEMPLATES.length]!;

      // Add a slight jitter (up to ~3-4 km) around the hub coordinates
      const latJitter = (Math.random() - 0.5) * 0.05;
      const lngJitter = (Math.random() - 0.5) * 0.05;
      const lat = Number((hub.lat + latJitter).toFixed(5));
      const lng = Number((hub.lng + lngJitter).toFixed(5));

      const slug = `synth-${hub.city.toLowerCase()}-${tpl.make.toLowerCase()}-${tpl.model.toLowerCase().replace(/\s+/g, '-')}-${index}`;
      const plate = `SYN${String(index).padStart(4, '0')}`.slice(0, 6).toUpperCase();

      vehicles.push({
        hostId: host._id,
        slug,
        regoPlate: plate,
        vin: `7A8SYNTHETIC${String(index).padStart(6, '0')}`,
        make: tpl.make,
        model: tpl.model,
        year: 2020 + (index % 5),
        variant: 'Standard',
        transmission: 'AUTOMATIC',
        bodyType: tpl.bodyType,
        fuelType: tpl.fuelType,
        seats: tpl.seats,
        doors: 5,
        features: ['Apple CarPlay', 'Bluetooth', 'Reversing camera', 'Cruise control'],
        wofExpiry: futureYear,
        regoExpiry: futureYear,
        powertrain: {
          engineCc: tpl.fuelType === 'EV' ? undefined : 1800,
          description: `${tpl.fuelType} powertrain`,
          evRangeKm: tpl.fuelType === 'EV' ? 400 : undefined,
          batteryKwh: tpl.fuelType === 'EV' ? 60 : undefined,
        },
        fuelPolicy: 'SAME_LEVEL',
        kmAllowancePerDay: 200,
        unlimitedKm: index % 3 === 0,
        petFriendly: index % 4 === 0,
        childSeat: index % 5 === 0,
        pricing: {
          dailyCents: tpl.dailyDollars * 100,
          weeklyDiscountPct: 10,
          monthlyDiscountPct: 20,
          extraKmCents: 35,
        },
        rules: {
          minDays: 1,
          maxDays: 30,
          minNoticeHours: 2,
          bufferHours: 2,
          instantBook: index % 2 === 0,
          cancellationTier: 'FLEXIBLE',
        },
        status: 'ACTIVE',
        location: point(lng, lat),
        suburb: hub.suburb,
        city: hub.city,
        region: hub.region,
        rating: { avg: 4.8 + (index % 3) * 0.1, count: 5 + (index % 40) },
        tripCount: 10 + (index % 50),
        bookingSeq: 0,
        photos: [
          {
            type: 'FRONT',
            url: 'https://media.rentovroom.com/demo/toyota-corolla-front.webp',
            order: 0,
            qualityFlag: 'OK',
            status: 'APPROVED',
          },
        ],
        documents: [
          { type: 'REGO', url: 'https://media.rentovroom.com/demo/rego.pdf', expiry: futureYear, status: 'VERIFIED' },
          { type: 'WOF', url: 'https://media.rentovroom.com/demo/wof.pdf', expiry: futureYear, status: 'VERIFIED' },
          { type: 'INSURANCE', url: 'https://media.rentovroom.com/demo/insurance.pdf', expiry: futureYear, status: 'VERIFIED' },
        ],
        deliveryOptions: [
          {
            type: 'PICKUP',
            label: 'Home location',
            address: {
              streetNumber: String(10 + (index % 90)),
              street: `${hub.suburb} Road`,
              suburb: hub.suburb,
              city: hub.city,
              region: hub.region,
              postcode: hub.postcode,
              location: point(lng, lat),
            },
            feeCents: 0,
          },
        ],
      });
    }

    await VehicleModel.insertMany(vehicles, { ordered: false });
    created += batchCount;
    process.stdout.write(`\rInserted ${created} / ${TOTAL_COUNT} vehicles...`);
  }

  console.log(`\nSuccessfully seeded ${TOTAL_COUNT} synthetic vehicles across 15 NZ hubs for load testing.`);
} finally {
  await disconnectDb();
}
