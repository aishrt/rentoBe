import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { runDataRetention } from '../src/modules/admin/data-retention.service.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { checkBookingVelocity } from '../src/modules/risk/risk-signals.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { createUser } from './helpers.js';

/*
 * The booking-velocity risk signal counts real bookings only (plan §14), and the retention job keeps
 * making progress past bookings whose cases are still open (plan §14, data retention).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

describe('booking velocity', () => {
  it('doesn’t count checkouts that ended unpaid: replaced ones, or ones whose hold ran out', async () => {
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const parties = { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id };
    const now = new Date();
    // The Guest changed the dates or options again and again: each replaced checkout expired unpaid.
    for (let index = 0; index < 8; index += 1) {
      await createBookingRecord(parties, {
        status: 'EXPIRED',
        statusHistory: [
          { status: 'PAYMENT_PENDING', at: now },
          { status: 'EXPIRED', at: now, reason: 'Replaced by a new checkout' },
        ],
      });
    }
    // The checkout under way now, and two real bookings (one a request the Host let expire).
    await createBookingRecord(parties, {
      status: 'PAYMENT_PENDING',
      statusHistory: [{ status: 'PAYMENT_PENDING', at: now }],
    });
    await createBookingRecord(parties);
    await createBookingRecord(parties, {
      status: 'EXPIRED',
      statusHistory: [
        { status: 'PAYMENT_PENDING', at: now },
        { status: 'PENDING', at: now },
        { status: 'EXPIRED', at: now },
      ],
    });
    await checkBookingVelocity(guest._id, now);
    expect((await UserModel.findById(guest._id).lean())!.riskFlags).toEqual([]);

    // Three more real ones: six in a day is more than the five allowed.
    for (let index = 0; index < 3; index += 1) await createBookingRecord(parties);
    await checkBookingVelocity(guest._id, now);
    expect((await UserModel.findById(guest._id).lean())!.riskFlags).toEqual([
      expect.objectContaining({ code: 'BOOKING_VELOCITY', detail: '6 bookings started in 24 hours' }),
    ]);
  });
});

describe('data retention', () => {
  it('keeps clearing old trips when more than a batch of them have open cases', async () => {
    const ended = new Date(Date.now() - 800 * DAY_MS);
    // More old bookings held by open cases than one run takes, stored first.
    const held = Array.from({ length: 201 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      ref: `RV-H${String(index).padStart(5, '0')}`,
      endAt: ended,
    }));
    await BookingModel.collection.insertMany(held);
    await IncidentModel.collection.insertMany(
      held.map((booking, index) => ({
        caseRef: `IN-H${String(index).padStart(5, '0')}`,
        bookingId: booking._id,
        status: 'INVESTIGATING',
        events: [],
      })),
    );
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const clearable = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'COMPLETED', startAt: new Date(ended.getTime() - 3 * DAY_MS), endAt: ended },
    );

    expect(await runDataRetention()).toMatchObject({ tripsCleared: 1 });
    expect((await BookingModel.findById(clearable._id).lean())!.tripRecordsClearedAt).toEqual(
      expect.any(Date),
    );
    expect(
      await BookingModel.countDocuments({ tripRecordsClearedAt: mongoose.trusted({ $exists: true }) }),
    ).toBe(1);
  });
});
