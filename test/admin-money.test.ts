import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { createStaff, createUser, staffAgent } from './helpers.js';

/*
 * The staff portal's money lists (plan §8.1, §12.6): every refund across payments, extra charges still
 * unpaid, and who may waive a Host's fees.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function trip(guestEmail = 'kiri@example.co.nz') {
  const host = (await UserModel.findOne({ email: 'hana@example.co.nz' })) ?? (await createHost());
  const guest = await createUser({ email: guestEmail });
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord({ guestId: guest._id, hostId: host._id, vehicleId: vehicle._id });
  return { host, guest, booking };
}

/** A support member, with the refunds permission when asked. */
async function support(refunds: boolean) {
  const member = await createStaff('sam@example.co.nz', 'SUPPORT');
  if (refunds) await UserModel.updateOne({ _id: member._id }, { $set: { permissions: ['REFUNDS'] } });
  return staffAgent('sam@example.co.nz');
}

describe('refunds', () => {
  it('lists every refund with who funds it, who issued it and how the Host repaid it, to search and filter', async () => {
    const admin = await createStaff();
    const { host, booking } = await trip();
    const other = await trip('mere@example.co.nz');
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS);
    await createPaymentRecord(booking, {
      status: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          amountCents: 2000,
          reason: 'Car wasn’t cleaned',
          kind: 'STAFF',
          issuedBy: admin._id,
          fundedBy: 'HOST',
          stripeRefundId: 're_host',
          status: 'SUCCEEDED',
          createdAt: day(1),
        },
        {
          amountCents: 1500,
          reason: 'Goodwill for the late pick-up',
          kind: 'STAFF',
          issuedBy: admin._id,
          fundedBy: 'PLATFORM',
          stripeRefundId: 're_goodwill',
          status: 'SUCCEEDED',
          createdAt: day(2),
        },
      ],
    });
    await createPaymentRecord(other.booking, {
      status: 'SUCCEEDED',
      refunds: [
        {
          amountCents: 33870,
          reason: 'Cancelled by the guest',
          kind: 'CANCELLATION',
          fundedBy: 'HOST',
          status: 'FAILED',
          failureReason: 'The card was closed',
          createdAt: day(3),
        },
      ],
    });
    // The Host-funded refund came after the payout: part taken back from the transfer, the rest still owed.
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21360,
      status: 'PAID',
      scheduledFor: day(5),
      paidAt: day(5),
      reversals: [
        { stripeReversalId: 'trr_1', amountCents: 1200, stripeRefundId: 're_host', createdAt: day(1) },
      ],
    });
    await UserModel.updateOne(
      { _id: host._id },
      {
        $set: {
          'hostProfile.refundsOwed': [
            { bookingId: booking._id, stripeRefundId: 're_host', amountCents: 800, createdAt: day(1) },
          ],
        },
      },
    );

    const refused = await support(false);
    expect((await refused.get('/api/v1/admin/refunds')).status).toBe(403);
    await UserModel.updateOne({ email: 'sam@example.co.nz' }, { $set: { permissions: ['REFUNDS'] } });

    const all = await refused.get('/api/v1/admin/refunds');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 3, page: 1 });
    // Newest first.
    expect(all.body.refunds.map((refund: { reason: string }) => refund.reason)).toEqual([
      'Car wasn’t cleaned',
      'Goodwill for the late pick-up',
      'Cancelled by the guest',
    ]);
    expect(all.body.refunds[0]).toEqual({
      id: expect.any(String),
      paymentId: expect.any(String),
      paymentType: 'BOOKING',
      bookingRef: booking.ref,
      guest: { id: booking.guestId.toString(), name: 'Kiri Tester' },
      amountCents: 2000,
      reason: 'Car wasn’t cleaned',
      kind: 'STAFF',
      fundedBy: 'HOST',
      status: 'SUCCEEDED',
      issuedBy: { id: admin.id, name: 'Aroha Tester' },
      hostRecovery: { deductedCents: 0, reversedCents: 1200, owedCents: 800 },
      createdAt: expect.any(String),
    });
    // A refund the platform funds isn't recovered from anyone.
    expect(all.body.refunds[1].hostRecovery).toBeUndefined();
    expect(all.body.refunds[2]).toMatchObject({
      bookingRef: other.booking.ref,
      kind: 'CANCELLATION',
      status: 'FAILED',
      failureReason: 'The card was closed',
    });
    expect(all.body.refunds[2].issuedBy).toBeUndefined();

    const reasons = async (query: Record<string, string>) =>
      (await refused.get('/api/v1/admin/refunds').query(query)).body.refunds.map(
        (refund: { reason: string }) => refund.reason,
      );
    expect(await reasons({ status: 'FAILED' })).toEqual(['Cancelled by the guest']);
    expect(await reasons({ fundedBy: 'PLATFORM' })).toEqual(['Goodwill for the late pick-up']);
    expect(await reasons({ kind: 'CANCELLATION' })).toEqual(['Cancelled by the guest']);
    expect(await reasons({ fundedBy: 'HOST', status: 'SUCCEEDED' })).toEqual(['Car wasn’t cleaned']);
    // By reference, whole or in part, in any case.
    expect(await reasons({ q: other.booking.ref.toLowerCase() })).toEqual(['Cancelled by the guest']);
    expect(await reasons({ q: booking.ref.slice(3) })).toHaveLength(2);
    expect(await reasons({ q: 'RV-ZZZZZZ' })).toEqual([]);
    expect((await refused.get('/api/v1/admin/refunds').query({ kind: 'GIFT' })).status).toBe(400);
  });

  it('pages through refunds 25 at a time', async () => {
    const { booking } = await trip();
    await createPaymentRecord(booking, {
      refunds: Array.from({ length: 27 }, (_, index) => ({
        amountCents: 100,
        reason: `Refund ${index + 1}`,
        fundedBy: 'PLATFORM' as const,
        status: 'SUCCEEDED' as const,
        createdAt: new Date(Date.now() - (27 - index) * 60_000),
      })),
    });
    const agent = await support(true);
    const second = await agent.get('/api/v1/admin/refunds').query({ page: 2 });
    expect(second.body).toMatchObject({ total: 27, page: 2 });
    expect(second.body.refunds.map((refund: { reason: string }) => refund.reason)).toEqual([
      'Refund 2',
      'Refund 1',
    ]);
  });
});

describe('unpaid extra charges', () => {
  it('lists the charges still to collect across bookings, with the last failure, the tries and the case', async () => {
    const { guest, booking } = await trip();
    const other = await trip('mere@example.co.nz');
    const incident = await IncidentModel.create({
      caseRef: 'IN-FUEL01',
      bookingId: booking._id,
      reporterId: booking.hostId,
      type: 'FUEL',
      description: 'Returned on empty',
    });
    const fuel = new mongoose.Types.ObjectId();
    const cleaning = new mongoose.Types.ObjectId();
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          extraCharges: [
            {
              _id: new mongoose.Types.ObjectId(),
              type: 'EXTRA_KM',
              description: '40 km over',
              amountCents: 1400,
              status: 'SUCCEEDED',
            },
            {
              _id: fuel,
              type: 'FUEL',
              description: 'Refuelling',
              amountCents: 6500,
              status: 'PENDING',
              incidentId: incident._id,
            },
          ],
        },
      },
    );
    await BookingModel.updateOne(
      { _id: other.booking._id },
      {
        $set: {
          extraCharges: [
            { _id: cleaning, type: 'CLEANING', description: 'Dog hair', amountCents: 8000, status: 'FAILED' },
            { type: 'TOLL', description: 'Northern Gateway', amountCents: 260, status: 'CANCELLED' },
          ],
        },
      },
    );
    await createPaymentRecord(booking, {
      type: 'EXTRA_CHARGE',
      extraChargeId: fuel,
      amountCents: 6500,
      status: 'FAILED',
      failureReason: 'Your card was declined.',
    });
    const tomorrow = new Date(Date.now() + DAY_MS);
    await JobModel.create([
      {
        type: 'extraCharge.collect',
        payload: { bookingId: booking.id, chargeId: fuel.toString(), attempt: 1 },
        refId: booking.id,
        runAt: new Date(Date.now() - DAY_MS),
        status: 'DONE',
        finishedAt: new Date(),
      },
      {
        type: 'extraCharge.collect',
        payload: { bookingId: booking.id, chargeId: fuel.toString(), attempt: 2 },
        refId: booking.id,
        runAt: tomorrow,
        status: 'QUEUED',
      },
    ]);

    const refused = await support(false);
    expect((await refused.get('/api/v1/admin/extra-charges')).status).toBe(403);
    await UserModel.updateOne({ email: 'sam@example.co.nz' }, { $set: { permissions: ['REFUNDS'] } });

    const list = await refused.get('/api/v1/admin/extra-charges');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 2, page: 1 });
    // Newest first: the cleaning charge was added after the fuel one.
    expect(list.body.charges).toEqual([
      {
        id: cleaning.toString(),
        bookingRef: other.booking.ref,
        guest: { id: other.guest.id, name: 'Kiri Tester' },
        type: 'CLEANING',
        description: 'Dog hair',
        amountCents: 8000,
        status: 'FAILED',
        createdAt: expect.any(String),
      },
      {
        id: fuel.toString(),
        bookingRef: booking.ref,
        guest: { id: guest.id, name: 'Kiri Tester' },
        type: 'FUEL',
        description: 'Refuelling',
        amountCents: 6500,
        status: 'PENDING',
        paymentStatus: 'FAILED',
        failureReason: 'Your card was declined.',
        attempts: 1,
        nextTryAt: tomorrow.toISOString(),
        incidentRef: 'IN-FUEL01',
        createdAt: expect.any(String),
      },
    ]);

    const failed = await refused.get('/api/v1/admin/extra-charges').query({ status: 'FAILED' });
    expect(failed.body.charges.map((charge: { id: string }) => charge.id)).toEqual([cleaning.toString()]);
    expect((await refused.get('/api/v1/admin/extra-charges').query({ status: 'SUCCEEDED' })).status).toBe(
      400,
    );
  });
});

describe('Host fees', () => {
  it('lets only the admin waive them, not support with the refunds permission (plan §8.1, item 10)', async () => {
    const host = await createHost();
    await UserModel.updateOne({ _id: host._id }, { $set: { 'hostProfile.feesOwedCents': 5000 } });
    const agent = await support(true);
    const refused = await agent
      .post(`/api/v1/admin/users/${host.id}/waive-host-fee`)
      .send({ reason: 'Cancelled for a medical emergency' });
    expect(refused.status).toBe(403);
    expect((await UserModel.findById(host._id))!.hostProfile!.feesOwedCents).toBe(5000);

    await createStaff();
    const admin = await staffAgent();
    const waived = await admin
      .post(`/api/v1/admin/users/${host.id}/waive-host-fee`)
      .send({ reason: 'Cancelled for a medical emergency' });
    expect(waived.status).toBe(200);
    expect(waived.body.user.host.feesOwedCents).toBe(0);
  });
});
