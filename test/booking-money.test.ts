import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { bookingResponseSchema } from '../src/modules/bookings/bookings.schemas.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createUser } from './helpers.js';

/* What each party sees about money on a booking after the trip: the payout's bank date and extra charges. */

const DAY_MS = 24 * 60 * 60 * 1000;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A completed trip between Hana (Host) and Kiri (Guest). */
async function completedTrip() {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  const startAt = new Date(Date.now() - 5 * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    { status: 'COMPLETED', startAt, endAt: new Date(startAt.getTime() + 3 * DAY_MS) },
  );
  return { host, guest, booking };
}

describe('a booking’s payout', () => {
  it('shows the Host when a paid payout should reach their bank, in business days', async () => {
    const { host, booking } = await completedTrip();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.payoutDelayDays': 2 } });
    // Friday 9 October 2026, 2 pm in Auckland: two business days on is Tuesday.
    const paidAt = new Date('2026-10-09T01:00:00.000Z');
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21360,
      status: 'PAID',
      scheduledFor: paidAt,
      paidAt,
    });

    const hostAgent = await signIn(host.email);
    const seen = bookingResponseSchema.parse((await hostAgent.get(`/api/v1/bookings/${booking.ref}`)).body);
    expect(seen.booking.payout).toMatchObject({
      status: 'PAID',
      paidAt: paidAt.toISOString(),
      expectedInBankBy: '2026-10-13T01:00:00.000Z',
      paidCents: 21360,
    });

    const guestAgent = await signIn('kiri@example.co.nz');
    const guestView = await guestAgent.get(`/api/v1/bookings/${booking.ref}`);
    expect(guestView.body.booking).not.toHaveProperty('payout');
  });
});

describe('extra charges on a booking', () => {
  it('are listed for both parties, with the pay link for the Guest when the saved card didn’t cover one', async () => {
    const { host, booking } = await completedTrip();
    const declinedPayment = new mongoose.Types.ObjectId();
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          extraCharges: [
            {
              type: 'EXTRA_KM',
              description: '50 km over the 750 km included, at $0.35 a km',
              amountCents: 1750,
              status: 'SUCCEEDED',
              paymentId: new mongoose.Types.ObjectId(),
            },
            {
              type: 'CLEANING',
              description: 'Sand through the back seats',
              amountCents: 6000,
              status: 'PENDING',
              paymentId: declinedPayment,
            },
            { type: 'TOLL', description: 'Tauranga Eastern Link', amountCents: 290, status: 'PENDING' },
          ],
        },
      },
    );

    const guestAgent = await signIn('kiri@example.co.nz');
    const guestView = bookingResponseSchema.parse(
      (await guestAgent.get(`/api/v1/bookings/${booking.ref}`)).body,
    );
    expect(guestView.booking.extraCharges).toEqual([
      expect.objectContaining({ type: 'EXTRA_KM', amountCents: 1750, status: 'PAID' }),
      expect.objectContaining({
        type: 'CLEANING',
        description: 'Sand through the back seats',
        amountCents: 6000,
        status: 'UNPAID',
        payPath: `/pay/${declinedPayment.toString()}`,
      }),
      expect.objectContaining({ type: 'TOLL', status: 'PENDING' }),
    ]);
    expect(guestView.booking.extraCharges![0]).not.toHaveProperty('payPath');

    // The Host sees the same charges, but the pay link is the Guest's.
    const hostAgent = await signIn(host.email);
    const hostView = bookingResponseSchema.parse(
      (await hostAgent.get(`/api/v1/bookings/${booking.ref}`)).body,
    );
    expect(hostView.booking.extraCharges?.map((charge) => charge.status)).toEqual([
      'PAID',
      'UNPAID',
      'PENDING',
    ]);
    expect(hostView.booking.extraCharges![1]).not.toHaveProperty('payPath');
  });

  it('are left out of a booking that has none', async () => {
    const { booking } = await completedTrip();
    const guestAgent = await signIn('kiri@example.co.nz');
    const view = await guestAgent.get(`/api/v1/bookings/${booking.ref}`);
    expect(view.status).toBe(200);
    expect(view.body.booking).not.toHaveProperty('extraCharges');
  });
});
