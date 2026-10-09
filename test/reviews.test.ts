import { describe, expect, it, vi } from 'vitest';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { reviewRequestJob, revealReviewsJob } from '../src/jobs/handlers/trip-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { toNzWallClock } from '../src/lib/nz-time.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import {
  REVEAL_SWEEP_HOUR,
  moderationReason,
  runReviewReveal,
  sweepReviewReveals,
} from '../src/modules/reviews/reviews.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A trip completed `daysAgo` days ago, with both sides signed in. */
async function completedTrip(daysAgo = 1) {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  const endAt = new Date(Date.now() - daysAgo * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    {
      status: 'COMPLETED',
      startAt: new Date(endAt.getTime() - 3 * DAY_MS),
      endAt,
      statusHistory: [{ status: 'COMPLETED', at: endAt }],
    },
  );
  return {
    host,
    guest,
    vehicle,
    booking,
    guestAgent: await signIn('kiri@example.co.nz'),
    hostAgent: await signIn('hana@example.co.nz'),
  };
}

/** Staff change the review window in Platform settings. */
async function setReviewWindow(windowDays: number) {
  await PlatformSettingsModel.updateOne(
    { _id: PLATFORM_SETTINGS_ID },
    { $set: { 'settings.reviews.windowDays': windowDays } },
    { upsert: true },
  );
}

const guestReview = (ref: string, body = 'Spotless car and a friendly host.') => ({
  bookingRef: ref,
  overall: 5,
  communication: 5,
  pickupReturn: 4,
  cleanliness: 5,
  body,
});

describe('moderation rules', () => {
  it('holds contact details, links and abusive language', () => {
    expect(moderationReason('Great trip, thanks!')).toBeNull();
    expect(moderationReason('Text me on 021 123 4567 next time')).toBe('Contains contact details or a link');
    expect(moderationReason('Book direct at www.example.com')).toBe('Contains contact details or a link');
    expect(moderationReason('What a shitty car')).toBe('Contains abusive language');
  });
});

describe('two-way reviews', () => {
  it('stay hidden until both sides have reviewed, then publish together and update the ratings', async () => {
    const { booking, guestAgent, hostAgent, host, vehicle, guest } = await completedTrip();
    await ReviewModel.create({
      bookingId: (await createBookingRecord({ guestId: guest._id, hostId: host._id, vehicleId: vehicle._id }))
        ._id,
      vehicleId: vehicle._id,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      overall: 3,
      status: 'PUBLISHED',
    });

    const first = await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref));
    expect(first.status).toBe(201);
    expect(first.body.review).toMatchObject({
      status: 'AWAITING_REVEAL',
      moderation: 'CLEAR',
      direction: 'GUEST_TO_HOST',
    });
    expect((await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref))).body.error.code).toBe(
      'ALREADY_REVIEWED',
    );

    const missing = await hostAgent
      .post('/api/v1/reviews')
      .send({ bookingRef: booking.ref, overall: 5, communication: 5, pickupReturn: 5 });
    expect(missing.body.error.fields.care).toBeDefined();
    const second = await hostAgent.post('/api/v1/reviews').send({
      bookingRef: booking.ref,
      overall: 4,
      communication: 5,
      pickupReturn: 4,
      care: 4,
      body: 'Lovely guest.',
    });
    expect(second.body.review.status).toBe('PUBLISHED');

    expect(await ReviewModel.countDocuments({ bookingId: booking._id, status: 'PUBLISHED' })).toBe(2);
    expect((await UserModel.findById(host._id).lean())!.hostProfile!.rating).toEqual({ avg: 4, count: 2 });
    expect((await VehicleModel.findById(vehicle._id).lean())!.rating).toEqual({ avg: 4, count: 2 });
    expect(await NotificationModel.countDocuments({ type: 'REVIEW_PUBLISHED', channel: 'IN_APP' })).toBe(2);

    const mine = await guestAgent.get('/api/v1/me/reviews');
    expect(mine.body.toWrite).toEqual([]);
    expect(mine.body.written[0]).toMatchObject({ bookingRef: booking.ref, subject: { firstName: 'Hana' } });
    expect(mine.body.received[0]).toMatchObject({
      author: { firstName: 'Hana' },
      care: 4,
      body: 'Lovely guest.',
    });

    const profile = await guestAgent.get(`/api/v1/users/${host.id}/reviews`);
    expect(profile.body.profile).toMatchObject({
      firstName: 'Hana',
      asHost: { rating: { avg: 4, count: 2 } },
    });
    expect(profile.body.reviews).toHaveLength(2);
  });

  it('show a member’s public profile with their reviews as Guest and as Host, and nothing private', async () => {
    const { booking, guestAgent, hostAgent, host, guest } = await completedTrip();
    await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref));
    await hostAgent
      .post('/api/v1/reviews')
      .send({ bookingRef: booking.ref, overall: 4, communication: 5, pickupReturn: 4, care: 4 });

    const guestProfile = await hostAgent.get(`/api/v1/users/${guest.id}/reviews`);
    expect(guestProfile.status).toBe(200);
    expect(guestProfile.body.profile).toEqual({
      id: guest.id,
      firstName: 'Kiri',
      joinedYear: expect.any(Number),
      verified: false,
      asGuest: { rating: { avg: 4, count: 1 }, tripCount: 1 },
    });
    expect(guestProfile.body.reviews).toEqual([
      expect.objectContaining({
        direction: 'HOST_TO_GUEST',
        author: expect.objectContaining({ id: host.id }),
      }),
    ]);
    // Which booking a review came from stays between the two of them, as does the moderation state.
    expect(guestProfile.body.reviews[0].bookingRef).toBe('');
    expect(guestProfile.body.reviews[0].moderation).toBeUndefined();
    expect(JSON.stringify(guestProfile.body)).not.toContain(booking.ref);
    expect(JSON.stringify(guestProfile.body)).not.toContain('example.co.nz');

    const hostProfile = await guestAgent.get(`/api/v1/users/${host.id}/reviews`);
    expect(hostProfile.body.profile.asHost).toMatchObject({ rating: { avg: 5, count: 1 } });
    expect(hostProfile.body.reviews).toEqual([expect.objectContaining({ direction: 'GUEST_TO_HOST' })]);

    // Signed in only; a suspended or closed account isn't shown.
    expect((await browserAgent().get(`/api/v1/users/${host.id}/reviews`)).status).toBe(401);
    await createUser({ email: 'tama@example.co.nz', firstName: 'Tama' });
    const member = await signIn('tama@example.co.nz');
    expect((await member.get(`/api/v1/users/${host.id}/reviews`)).status).toBe(200);
    await UserModel.updateOne({ _id: host._id }, { $set: { status: 'SUSPENDED' } });
    expect((await member.get(`/api/v1/users/${host.id}/reviews`)).status).toBe(404);
    await UserModel.updateOne({ _id: guest._id }, { $set: { closedAt: new Date() } });
    expect((await member.get(`/api/v1/users/${guest.id}/reviews`)).status).toBe(404);
    expect((await member.get('/api/v1/users/not-an-id/reviews')).status).toBe(404);
  });

  it('are published by the reveal job when the window closes with one side in', async () => {
    const { booking, guestAgent } = await completedTrip(13);
    await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref));
    await revealReviewsJob({ bookingId: booking.id }, context);
    expect((await ReviewModel.findOne({ bookingId: booking._id }))!.status).toBe('AWAITING_REVEAL');

    await ReviewModel.collection.updateOne({ bookingId: booking._id }, { $set: { createdAt: new Date() } });
    const { BookingModel } = await import('../src/modules/bookings/booking.model.js');
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { statusHistory: [{ status: 'COMPLETED', at: new Date(Date.now() - 15 * DAY_MS) }] } },
    );
    await revealReviewsJob({ bookingId: booking.id }, context);
    expect((await ReviewModel.findOne({ bookingId: booking._id }))!.status).toBe('PUBLISHED');
  });

  it('wait for a lengthened window: the reveal job is queued again for when it now closes', async () => {
    const { booking, guestAgent } = await completedTrip(13);
    await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref));
    // Staff lengthen the window from 14 to 30 days after the trip's reveal job was queued.
    await setReviewWindow(30);
    await revealReviewsJob({ bookingId: booking.id }, context);
    expect((await ReviewModel.findOne({ bookingId: booking._id }))!.status).toBe('AWAITING_REVEAL');

    const closes = new Date(booking.endAt.getTime() + 30 * DAY_MS);
    const again = await JobModel.find({ type: 'reviews.reveal' });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({
      runAt: closes,
      uniqueKey: `reviews.reveal:${booking.id}:${closes.getTime()}`,
      refId: booking.id,
    });
    // The author is told the new date, not the one the old window gave.
    expect((await guestAgent.get('/api/v1/me/reviews')).body.written[0].revealAt).toBe(closes.toISOString());

    // When that job runs, the window has closed: it's published, and nothing more is queued.
    expect(await runReviewReveal(booking.id, new Date(closes.getTime() + 60_000))).toBe(1);
    expect((await ReviewModel.findOne({ bookingId: booking._id }))!.status).toBe('PUBLISHED');
    expect(await JobModel.countDocuments({ type: 'reviews.reveal' })).toBe(1);
  });

  it('are published by the daily sweep once a shortened window has closed, unless held', async () => {
    const { booking, guestAgent, hostAgent, guest } = await completedTrip(5);
    await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref));

    // Still inside the 14-day window: the sweep leaves it waiting, and queues tomorrow's run once.
    expect(await sweepReviewReveals()).toBe(0);
    await sweepReviewReveals();
    const sweeps = await JobModel.find({ type: 'daily.reviewReveal' });
    expect(sweeps).toHaveLength(1);
    expect(toNzWallClock(sweeps[0]!.runAt).hour).toBe(REVEAL_SWEEP_HOUR);
    expect((await ReviewModel.findOne({ authorId: guest._id }))!.status).toBe('AWAITING_REVEAL');

    // Staff shorten the window to 3 days: it has closed, so the author is told it's out by the next sweep.
    await setReviewWindow(3);
    const revealAt = new Date((await guestAgent.get('/api/v1/me/reviews')).body.written[0].revealAt);
    expect(revealAt.getTime()).toBeGreaterThan(Date.now());
    expect(revealAt.getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect(await sweepReviewReveals()).toBe(1);
    expect((await ReviewModel.findOne({ authorId: guest._id }))!.status).toBe('PUBLISHED');

    // A review held for a moderator stays held.
    await setReviewWindow(14);
    await hostAgent.post('/api/v1/reviews').send({
      bookingRef: booking.ref,
      overall: 2,
      communication: 2,
      pickupReturn: 2,
      care: 2,
      body: 'Call me on 021 555 1234',
    });
    await setReviewWindow(3);
    expect(await sweepReviewReveals()).toBe(0);
    expect((await ReviewModel.findOne({ direction: 'HOST_TO_GUEST' }))!.status).toBe('AWAITING_REVEAL');
  });

  it('can’t be written after the window, for a trip that isn’t done, or by someone else', async () => {
    const late = await completedTrip(20);
    expect(
      (await late.guestAgent.post('/api/v1/reviews').send(guestReview(late.booking.ref))).body.error.code,
    ).toBe('REVIEW_CLOSED');
    await createUser({ email: 'nosy@example.co.nz' });
    const nosy = await signIn('nosy@example.co.nz');
    expect((await nosy.post('/api/v1/reviews').send(guestReview(late.booking.ref))).status).toBe(404);
  });

  it('ask both sides after the trip, and a moderator clears or hides held reviews', async () => {
    const { booking, guestAgent, hostAgent, host, guest } = await completedTrip();
    await reviewRequestJob({ bookingId: booking.id }, context);
    expect(await NotificationModel.countDocuments({ type: 'REVIEW_REQUEST', channel: 'EMAIL' })).toBe(2);

    const held = await guestAgent
      .post('/api/v1/reviews')
      .send(guestReview(booking.ref, 'Call me on 021 555 1234!'));
    expect(held.body.review.moderation).toBe('HELD');
    await hostAgent
      .post('/api/v1/reviews')
      .send({ bookingRef: booking.ref, overall: 5, communication: 5, pickupReturn: 5, care: 5 });
    // The host's is published; the held one waits for a moderator.
    expect((await ReviewModel.findOne({ authorId: host._id }))!.status).toBe('PUBLISHED');
    expect((await ReviewModel.findOne({ authorId: guest._id }))!.status).toBe('AWAITING_REVEAL');

    await createStaff('aroha@example.co.nz', 'SUPPORT');
    const staff = await staffAgent();
    const queue = await staff.get('/api/v1/admin/reviews');
    expect(queue.body.reviews).toEqual([
      expect.objectContaining({
        id: held.body.review.id,
        moderationReason: 'Contains contact details or a link',
      }),
    ]);
    const hidden = await staff
      .post(`/api/v1/admin/reviews/${held.body.review.id}/moderate`)
      .send({ action: 'HIDE', reason: 'Shares a phone number' });
    expect(hidden.body.review.status).toBe('HIDDEN');
    expect(await AuditLogModel.countDocuments({ action: 'review.hidden' })).toBe(1);

    // Hidden by mistake: clearing it publishes it after all, since both reviews are in.
    const restored = await staff
      .post(`/api/v1/admin/reviews/${held.body.review.id}/moderate`)
      .send({ action: 'CLEAR', reason: 'The number was the Host’s business line' });
    expect(restored.body.review.status).toBe('PUBLISHED');
  });

  it('can be reported by anyone but their author, and staff hide a published one with a reason', async () => {
    const { booking, guestAgent, hostAgent, guest, vehicle } = await completedTrip();
    await guestAgent.post('/api/v1/reviews').send(guestReview(booking.ref, 'The host was rude to me.'));
    await hostAgent
      .post('/api/v1/reviews')
      .send({ bookingRef: booking.ref, overall: 5, communication: 5, pickupReturn: 5, care: 5 });
    const id = (await ReviewModel.findOne({ authorId: guest._id, status: 'PUBLISHED' }))!.id as string;

    // The listing says who wrote each review, so the website leaves Report off the reader's own.
    const listing = await browserAgent().get(`/api/v1/vehicles/${vehicle.id}/reviews`);
    expect(listing.body.reviews).toEqual([
      expect.objectContaining({ id, author: expect.objectContaining({ id: guest.id, firstName: 'Kiri' }) }),
    ]);

    const report = { targetType: 'REVIEW', targetId: id, reason: 'FAKE', note: 'This never happened.' };
    expect((await guestAgent.post('/api/v1/reports').send(report)).body.error.code).toBe('OWN_CONTENT');
    expect((await hostAgent.post('/api/v1/reports').send(report)).status).toBe(201);
    await createUser({ email: 'tama@example.co.nz', firstName: 'Tama' });
    const reader = await signIn('tama@example.co.nz');
    expect((await reader.post('/api/v1/reports').send({ ...report, reason: 'HARASSMENT' })).status).toBe(201);

    await createStaff('aroha@example.co.nz', 'SUPPORT');
    const staff = await staffAgent();
    const queue = await staff.get('/api/v1/admin/moderation/reports');
    expect(queue.body.reports).toHaveLength(2);
    expect(queue.body.reports[0]).toMatchObject({
      targetType: 'REVIEW',
      subject: { id: guest.id },
      preview: '5★ The host was rude to me.',
      review: {
        id,
        bookingRef: booking.ref,
        author: { id: guest.id, firstName: 'Kiri' },
        subject: { firstName: 'Hana' },
        vehicleTitle: expect.any(String),
        overall: 5,
        body: 'The host was rude to me.',
        status: 'PUBLISHED',
        moderation: 'CLEAR',
      },
    });

    // Published reviews are listed for staff too, newest first, both sides of the trip.
    const published = await staff.get('/api/v1/admin/reviews?state=PUBLISHED');
    expect(published.body.reviews).toHaveLength(2);
    expect(published.body.reviews).toContainEqual(
      expect.objectContaining({ id, status: 'PUBLISHED', moderation: 'CLEAR' }),
    );

    const hidden = await staff
      .post(`/api/v1/admin/reviews/${id}/moderate`)
      .send({ action: 'HIDE', reason: 'Reported as fake; the Host’s messages show otherwise' });
    expect(hidden.body.review).toMatchObject({ status: 'HIDDEN', moderation: 'HIDDEN' });
    expect(await AuditLogModel.countDocuments({ action: 'review.hidden' })).toBe(1);
    // Out of the car's rating and off the listing.
    expect((await VehicleModel.findById(vehicle._id).lean())!.rating).toEqual({ avg: 0, count: 0 });
    expect((await browserAgent().get(`/api/v1/vehicles/${vehicle.id}/reviews`)).body.reviews).toEqual([]);

    expect((await staff.get('/api/v1/admin/reviews?state=PUBLISHED')).body.reviews).toHaveLength(1);
    expect((await staff.get('/api/v1/admin/reviews?state=HIDDEN')).body.reviews).toEqual([
      expect.objectContaining({
        id,
        moderationReason: 'Reported as fake; the Host’s messages show otherwise',
      }),
    ]);
    const after = await staff.get('/api/v1/admin/moderation/reports');
    expect(after.body.reports[0].review).toMatchObject({ status: 'HIDDEN', moderation: 'HIDDEN' });
  });
});
