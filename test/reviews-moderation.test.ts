import { describe, expect, it, vi } from 'vitest';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { memberReviews, moderateReview, myReviews } from '../src/modules/reviews/reviews.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { createStaff, createUser } from './helpers.js';

/* Moderating a review two at a time, the trips waiting for a review, and a member's joined year (spec §16). */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A completed trip that ended `endedDaysAgo` days ago and was completed `completedDaysAgo` days ago. */
async function completedTrip(endedDaysAgo: number, completedDaysAgo = endedDaysAgo) {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  const endAt = new Date(Date.now() - endedDaysAgo * DAY_MS);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    {
      status: 'COMPLETED',
      startAt: new Date(endAt.getTime() - 3 * DAY_MS),
      endAt,
      statusHistory: [{ status: 'COMPLETED', at: new Date(Date.now() - completedDaysAgo * DAY_MS) }],
    },
  );
  return { host, guest, booking };
}

describe('moderating a review', () => {
  it('refuses a moderator acting on a review another moderator has just changed', async () => {
    const { host, guest, booking } = await completedTrip(1);
    const staff = await createStaff();
    const review = await ReviewModel.create({
      bookingId: booking._id,
      vehicleId: booking.vehicleId,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      overall: 2,
      communication: 2,
      pickupReturn: 2,
      cleanliness: 2,
      body: 'Text me on 021 123 4567',
      status: 'AWAITING_REVEAL',
      revealAt: new Date(Date.now() + 13 * DAY_MS),
      moderation: { state: 'HELD', reason: 'Contains contact details or a link' },
    });
    // The second moderator opened it while it was still held.
    const asOpened = await ReviewModel.findById(review._id).lean();
    await moderateReview(staff.id, review.id, 'HIDE', 'Shares a phone number');

    vi.spyOn(ReviewModel, 'findById').mockReturnValueOnce({ lean: async () => asOpened } as never);
    await expect(moderateReview(staff.id, review.id, 'CLEAR', 'Looks fine')).rejects.toMatchObject({
      status: 409,
      code: 'REVIEW_CHANGED',
    });
    // Still hidden, and still on the moderators' Hidden list.
    expect(await ReviewModel.findById(review._id).lean()).toMatchObject({
      status: 'HIDDEN',
      moderation: { state: 'HIDDEN' },
    });
  });

  it('tells a held review’s author what the team decided, in their own reviews tab', async () => {
    const { host, guest, booking } = await completedTrip(1);
    const staff = await createStaff();
    const held = { state: 'HELD', reason: 'Contains contact details or a link' };
    const scores = { overall: 4, communication: 4, pickupReturn: 4 };
    const byHost = await ReviewModel.create({
      bookingId: booking._id,
      authorId: host._id,
      subjectId: guest._id,
      direction: 'HOST_TO_GUEST',
      ...scores,
      care: 4,
      body: 'Text me on 021 123 4567',
      status: 'AWAITING_REVEAL',
      moderation: held,
    });
    const notices = (userId: unknown) =>
      NotificationModel.find({ userId, type: 'REVIEW_MODERATED', channel: 'IN_APP' }).lean();

    // The Host's is cleared before the Guest has reviewed: it waits for the reveal.
    await moderateReview(staff.id, byHost.id, 'CLEAR', 'A business line');
    expect((await notices(host._id)).map((notice) => notice.payload)).toEqual([
      {
        title: 'Your review of Kiri passed our check',
        body: 'It’s published once you’ve both reviewed the trip, or when the time to review closes.',
        link: '/account/reviews?tab=written&as=host',
      },
    ]);

    // The Guest's is hidden, with why.
    const byGuest = await ReviewModel.create({
      bookingId: booking._id,
      vehicleId: booking.vehicleId,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      ...scores,
      cleanliness: 4,
      body: 'Email me at kiri@example.co.nz',
      status: 'AWAITING_REVEAL',
      moderation: held,
    });
    await moderateReview(staff.id, byGuest.id, 'HIDE', 'Shares an email address');
    expect((await notices(guest._id)).map((notice) => notice.payload)).toEqual([
      {
        title: 'Your review of Hana won’t be published',
        body: 'Our team hid it: Shares an email address',
        link: '/account/reviews?tab=written',
      },
    ]);

    // Restored later: it's no longer a held review, so nothing more is sent about it.
    await moderateReview(staff.id, byGuest.id, 'CLEAR', 'The address was a business one');
    expect(await notices(guest._id)).toHaveLength(1);
  });

  it('tells the author their held review is published when the team clears it', async () => {
    const { host, guest, booking } = await completedTrip(1);
    const staff = await createStaff();
    const review = await ReviewModel.create({
      bookingId: booking._id,
      vehicleId: booking.vehicleId,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      overall: 5,
      communication: 5,
      pickupReturn: 5,
      cleanliness: 5,
      body: 'Visit www.example.com',
      status: 'AWAITING_REVEAL',
      moderation: { state: 'HELD', reason: 'Contains contact details or a link' },
    });
    // The Host reviewed too, so clearing it publishes both.
    await ReviewModel.create({
      bookingId: booking._id,
      authorId: host._id,
      subjectId: guest._id,
      direction: 'HOST_TO_GUEST',
      overall: 5,
      communication: 5,
      pickupReturn: 5,
      care: 5,
      status: 'AWAITING_REVEAL',
      moderation: { state: 'CLEAR' },
    });

    await moderateReview(staff.id, review.id, 'CLEAR', 'A harmless link');
    const [notice] = await NotificationModel.find({ userId: guest._id, type: 'REVIEW_MODERATED' }).lean();
    expect(notice!.payload).toMatchObject({
      title: 'Your review of Hana is published',
      link: '/account/reviews?tab=written',
    });
    // Hana hears about it in the Host area.
    const [published] = await NotificationModel.find({ userId: host._id, type: 'REVIEW_PUBLISHED' }).lean();
    expect(published!.payload).toMatchObject({
      title: 'Kiri reviewed you',
      link: '/account/reviews?as=host',
    });
  });
});

describe('trips waiting for a review', () => {
  it('lists a trip completed late for as long as its window is open', async () => {
    // Ended a month ago, but support only completed it two days ago: 12 days left to review it.
    const { guest, booking } = await completedTrip(30, 2);
    const { toWrite } = await myReviews(guest.id);
    expect(toWrite).toEqual([
      expect.objectContaining({
        bookingRef: booking.ref,
        closesAt: new Date(booking.statusHistory[0]!.at.getTime() + 14 * DAY_MS).toISOString(),
      }),
    ]);
  });

  it('leaves out a trip whose window has closed', async () => {
    const { guest } = await completedTrip(20, 15);
    expect((await myReviews(guest.id)).toWrite).toEqual([]);
  });
});

describe('a member’s public profile', () => {
  it('gives the year they joined in New Zealand', async () => {
    const member = await createUser();
    // 1 am on New Year's Day in New Zealand is still the year before in UTC.
    await UserModel.collection.updateOne(
      { _id: member._id },
      { $set: { createdAt: new Date('2025-12-31T12:00:00Z') } },
    );
    expect((await memberReviews(member.id)).profile.joinedYear).toBe(2026);
  });
});
