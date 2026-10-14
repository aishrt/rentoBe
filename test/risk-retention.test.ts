import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localFilePath } from '../src/integrations/storage/local-files.js';
import { stripe } from '../src/integrations/stripe.js';
import { runDataRetention } from '../src/modules/admin/data-retention.service.js';
import { DEFAULT_SETTINGS } from '../src/modules/admin/default-settings.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { checkBookingVelocity, checkPaymentRisk } from '../src/modules/risk/risk-signals.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
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

describe('data retention with a bad period saved', () => {
  it('never deletes the audit log or recent trip records, even with 0 years stored', async () => {
    await PlatformSettingsModel.updateOne(
      { _id: PLATFORM_SETTINGS_ID },
      {
        $set: {
          settings: {
            ...DEFAULT_SETTINGS,
            retention: { ...DEFAULT_SETTINGS.retention, auditLogYears: 0, tripRecordsYears: 0 },
          },
        },
      },
      { upsert: true },
    );
    const now = new Date();
    await AuditLogModel.collection.insertMany([
      {
        action: 'user.suspended',
        entity: 'user',
        entityId: 'recent',
        createdAt: new Date(now.getTime() - DAY_MS),
      },
      {
        action: 'user.suspended',
        entity: 'user',
        entityId: 'old',
        createdAt: new Date(now.getTime() - 8 * 365 * DAY_MS),
      },
    ]);
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const recentTrip = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      {
        status: 'COMPLETED',
        startAt: new Date(now.getTime() - 5 * DAY_MS),
        endAt: new Date(now.getTime() - 2 * DAY_MS),
      },
    );

    const result = await runDataRetention(now);
    // Only the entry past the 7-year default goes.
    expect(result).toMatchObject({ auditLogsDeleted: 1, tripsCleared: 0 });
    expect(await AuditLogModel.exists({ entityId: 'recent' })).toBeTruthy();
    expect((await BookingModel.findById(recentTrip._id).lean())!.tripRecordsClearedAt).toBeUndefined();
  });
});

describe('a card from another country', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is compared with the licence’s country by code, whatever name it was saved under', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const cases = [
      // [licence country as saved, card country, flagged]
      ['USA', 'US', false],
      ['US', 'US', false],
      ['England', 'GB', false],
      ['United Kingdom', 'GB', false],
      ['AU', 'US', true],
    ] as const;
    for (const [index, [licenceCountry, cardCountry, flagged]] of cases.entries()) {
      const guest = await createUser({ email: `card${index}@example.co.nz` });
      await UserModel.updateOne(
        { _id: guest._id },
        {
          $set: {
            driverLicence: {
              numberHash: `hash${index}`,
              country: licenceCountry,
              class: 'OVERSEAS',
              expiry: new Date(Date.now() + 400 * DAY_MS),
              status: 'APPROVED',
            },
          },
        },
      );
      const booking = await createBookingRecord({
        guestId: guest._id,
        hostId: host._id,
        vehicleId: vehicle._id,
      });
      const payment = await createPaymentRecord(booking);
      vi.spyOn(stripe().paymentIntents, 'retrieve').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        latest_charge: { id: 'ch_1', payment_method_details: { card: { country: cardCountry } } },
      } as unknown as Stripe.Response<Stripe.PaymentIntent>);
      await checkPaymentRisk(payment.id);
      const flags = (await UserModel.findById(guest._id).lean())!.riskFlags ?? [];
      expect(
        flags.some((flag) => flag.code === 'CARD_COUNTRY'),
        `${licenceCountry} / ${cardCountry}`,
      ).toBe(flagged);
      if (flagged) {
        expect(flags[0]!.detail).toBe(
          `Card issued in United States for ${booking.ref}; licence from Australia`,
        );
      }
    }
  });
});

describe('data retention of message photos', () => {
  it('deletes a message photo and its smaller copy with the trip records', async () => {
    const ended = new Date(Date.now() - 800 * DAY_MS);
    const host = await createHost();
    const guest = await createUser();
    const vehicle = await createVehicle(host._id);
    const booking = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'COMPLETED', startAt: new Date(ended.getTime() - 3 * DAY_MS), endAt: ended },
    );
    const folder = `bookings/${booking.id}/messages`;
    const files = [`${folder}/${randomUUID()}.jpg`, `${folder}/${randomUUID()}-800.webp`];
    for (const file of files) {
      await mkdir(dirname(localFilePath(file)), { recursive: true });
      await writeFile(localFilePath(file), 'photo');
    }
    const thread = await ThreadModel.create({
      bookingId: booking._id,
      participantIds: [guest._id, host._id],
    });
    await MessageModel.create({
      threadId: thread._id,
      senderId: guest._id,
      body: '',
      attachments: [{ url: `local:${files[0]}`, previewUrl: `local:${files[1]}`, contentType: 'image/jpeg' }],
    });

    expect(await runDataRetention()).toMatchObject({ tripsCleared: 1 });
    for (const file of files) await expect(stat(localFilePath(file))).rejects.toThrow();
  });
});
