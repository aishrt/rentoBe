/**
 * Sets a booking's start time to 30 minutes from now for end-to-end testing (frontend/e2e),
 * so that the digital handover check-in window (which opens 2 hours before start) is open
 * immediately. Refuses to run in production or with live Stripe keys.
 *
 *   npx tsx scripts/e2e-open-checkin.ts RV-XXXXXX
 */
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';

const ref = process.argv[2]?.trim().toUpperCase();
if (!ref) {
  throw new Error('Pass the booking reference: npx tsx scripts/e2e-open-checkin.ts RV-XXXXXX');
}

if (env.NODE_ENV === 'production' || env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
  throw new Error('This helper is for local tests only. It never runs in production.');
}

await connectDb();
try {
  const booking = await BookingModel.findOne({ ref });
  if (!booking) throw new Error(`No booking found with reference ${ref}.`);

  const now = Date.now();
  // Start in 30 minutes so check-in (startAt - 2 hours) is open now.
  const newStart = new Date(now + 30 * 60 * 1000);
  const newEnd = new Date(now + 24 * 60 * 60 * 1000);

  booking.startAt = newStart;
  booking.endAt = newEnd;
  await booking.save();

  await AvailabilityBlockModel.updateMany(
    { bookingId: booking._id },
    { $set: { startAt: newStart, endAt: newEnd } },
  );

  console.log(`Booking ${ref} updated: check-in is now open (startAt: ${newStart.toISOString()}).`);
} finally {
  await disconnectDb();
}
