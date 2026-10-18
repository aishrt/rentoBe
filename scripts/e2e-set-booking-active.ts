/**
 * Sets a booking's status to ACTIVE with a valid CHECK_IN condition report for end-to-end
 * testing (frontend/e2e), allowing tests to immediately test post-check-in workflows such as
 * missing check-out completion by support staff or guest no-show resolution.
 * Refuses to run in production or with live Stripe keys.
 *
 *   npx tsx scripts/e2e-set-booking-active.ts RV-XXXXXX
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';

const ref = process.argv[2]?.trim().toUpperCase();
if (!ref) {
  throw new Error('Pass the booking reference: npx tsx scripts/e2e-set-booking-active.ts RV-XXXXXX');
}

if (env.NODE_ENV === 'production' || env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  throw new Error('This helper is for local tests only. It never runs in production.');
}

await connectDb();
try {
  const booking = await BookingModel.findOne({ ref });
  if (!booking) throw new Error(`No booking found with reference ${ref}.`);

  const now = new Date();
  booking.status = 'ACTIVE';
  await booking.save();

  // Create or update CHECK_IN condition report
  await ConditionReportModel.findOneAndUpdate(
    { bookingId: booking._id, stage: 'CHECK_IN' },
    {
      $set: {
        submittedBy: booking.hostId,
        odometer: 45000,
        fuelOrBatteryPct: 100,
        notes: 'E2E test check-in completed',
        damagePins: [],
        photos: [],
        confirmedByGuestAt: now,
        confirmedByHostAt: now,
      },
    },
    { upsert: true, new: true },
  );

  console.log(`Booking ${ref} is now ACTIVE with check-in readings (odometer: 45,000 km, fuel: 100%).`);
} finally {
  await disconnectDb();
}
