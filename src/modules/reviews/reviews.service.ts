import mongoose, { type ClientSession, type Types } from 'mongoose';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { maskContactDetails } from '../messages/masking.js';
import { notify } from '../notifications/notify.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { ReviewModel, type Review, type ReviewDirection } from './review.model.js';
import type { ReviewInput, ReviewView } from './reviews.schemas.js';

/*
 * Two-way reviews (spec §16; plan §9 Days 21–22). After a completed trip, the Guest reviews the Host and
 * the car, and the Host reviews the Guest, within the review window in settings. Both are revealed
 * together once both are in, or when the window closes (`reviews.reveal`), so neither side can retaliate.
 * Reviews with contact details, links or abusive language are held for a moderator; anyone can report a
 * review, and staff hide one with a recorded reason.
 */

type Id = Types.ObjectId;
type BookingRecord = Booking & { _id: Id };
type ReviewRecord = Review & { _id: Id };

const DAY_MS = 24 * 60 * 60 * 1000;
const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

/** Words that hold a review for a moderator (plan §9: abusive language). Matched as whole words. */
const ABUSIVE = [
  'fuck',
  'fucking',
  'fucked',
  'shit',
  'shitty',
  'cunt',
  'bitch',
  'bastard',
  'asshole',
  'arsehole',
  'dickhead',
  'wanker',
  'slut',
  'whore',
  'retard',
  'twat',
  'scumbag',
];
const ABUSIVE_PATTERN = new RegExp(`\\b(${ABUSIVE.join('|')})\\b`, 'i');

/** Why a review needs a moderator before it's published, or null when it can go out (plan §9). */
export function moderationReason(body: string | undefined): string | null {
  if (!body) return null;
  if (maskContactDetails(body) !== body) return 'Contains contact details or a link';
  if (ABUSIVE_PATTERN.test(body)) return 'Contains abusive language';
  return null;
}

/** When the booking's trip was completed: check-out, or support completing it. */
function completedAt(booking: Pick<Booking, 'statusHistory' | 'endAt'>): Date {
  return (
    [...booking.statusHistory].reverse().find((change) => change.status === 'COMPLETED')?.at ?? booking.endAt
  );
}

/** The last moment to review a trip: the window in settings after it was completed. */
export function reviewWindowCloses(
  booking: Pick<Booking, 'statusHistory' | 'endAt'>,
  windowDays: number,
): Date {
  return new Date(completedAt(booking).getTime() + windowDays * DAY_MS);
}

const directionFor = (
  booking: Pick<Booking, 'guestId' | 'hostId'>,
  userId: Id | string,
): ReviewDirection | null =>
  booking.guestId.equals(userId) ? 'GUEST_TO_HOST' : booking.hostId.equals(userId) ? 'HOST_TO_GUEST' : null;

async function toViews(reviews: ReviewRecord[], viewerId?: string): Promise<ReviewView[]> {
  if (reviews.length === 0) return [];
  const people = await UserModel.find({
    _id: mongoose.trusted({
      $in: [...reviews.map((review) => review.authorId), ...reviews.map((review) => review.subjectId)],
    }),
  })
    .select('firstName avatarUrl')
    .lean();
  const bookings = await BookingModel.find({
    _id: mongoose.trusted({ $in: reviews.map((review) => review.bookingId) }),
  })
    .select('ref vehicleSnapshot.title')
    .lean();
  const name = (id: Id) => people.find((person) => person._id.equals(id));
  return reviews.map((review) => {
    const author = name(review.authorId);
    const booking = bookings.find((candidate) => candidate._id.equals(review.bookingId));
    const own = viewerId !== undefined && review.authorId.equals(viewerId);
    return {
      id: review._id.toString(),
      bookingRef: booking?.ref ?? '',
      direction: review.direction,
      author: {
        id: review.authorId.toString(),
        firstName: author?.firstName ?? 'Former member',
        ...(author?.avatarUrl && { avatarUrl: author.avatarUrl }),
      },
      subject: {
        id: review.subjectId.toString(),
        firstName: name(review.subjectId)?.firstName ?? 'Former member',
      },
      vehicleTitle: booking?.vehicleSnapshot.title ?? 'A car',
      overall: review.overall,
      ...(review.communication && { communication: review.communication }),
      ...(review.pickupReturn && { pickupReturn: review.pickupReturn }),
      ...(review.cleanliness && { cleanliness: review.cleanliness }),
      ...(review.care && { care: review.care }),
      ...(review.body && { body: review.body }),
      status: review.status,
      ...(own && { moderation: review.moderation.state }),
      ...(review.revealAt &&
        review.status === 'AWAITING_REVEAL' && { revealAt: review.revealAt.toISOString() }),
      createdAt: review.createdAt.toISOString(),
    };
  });
}

/** Recounts the Host's and the car's ratings from published Guest reviews (plan §3: rating totals). */
async function recountRatings(hostId: Id, vehicleId: Id | undefined, session?: ClientSession) {
  const average = async (match: Record<string, unknown>) => {
    const [row] = await ReviewModel.aggregate<{ avg: number; count: number }>([
      { $match: { ...match, direction: 'GUEST_TO_HOST', status: 'PUBLISHED' } },
      { $group: { _id: null, avg: { $avg: '$overall' }, count: { $sum: 1 } } },
    ]).session(session ?? null);
    return { avg: Math.round((row?.avg ?? 0) * 100) / 100, count: row?.count ?? 0 };
  };
  await UserModel.updateOne(
    { _id: hostId },
    { $set: { 'hostProfile.rating': await average({ subjectId: hostId }) } },
    { session },
  );
  if (vehicleId)
    await VehicleModel.updateOne(
      { _id: vehicleId },
      { $set: { rating: await average({ vehicleId }) } },
      { session },
    );
  forget('vehicles:featured');
}

/** Publishes reviews, tells each subject, and recounts the Host's and the car's ratings. */
async function publish(reviews: ReviewRecord[], now: Date) {
  for (const review of reviews) {
    const published = await ReviewModel.findOneAndUpdate(
      { _id: review._id, status: 'AWAITING_REVEAL', 'moderation.state': 'CLEAR' },
      { $set: { status: 'PUBLISHED', revealAt: now } },
      { new: true },
    ).lean<ReviewRecord>();
    if (!published) continue;
    if (published.direction === 'GUEST_TO_HOST')
      await recountRatings(published.subjectId, published.vehicleId);
    const author = await UserModel.findById(published.authorId).select('firstName').lean();
    await notify({
      userId: published.subjectId,
      type: 'REVIEW_PUBLISHED',
      title: `${author?.firstName ?? 'Someone'} reviewed you`,
      body: `${published.overall} out of 5 stars.`,
      link: '/account/reviews',
      dedupeKey: `REVIEW_PUBLISHED:${published._id.toString()}`,
    });
  }
}

/**
 * Publishes a booking's reviews when it's time: both sides are in, the window has closed, or the client
 * chose not to reveal them together. A review held by moderation stays held (plan §4.3, `reviews.reveal`).
 */
export async function revealReviews(bookingId: Id | string, now = new Date()): Promise<number> {
  const booking = await BookingModel.findById(bookingId).lean<BookingRecord>();
  if (!booking) return 0;
  const settings = await getPlatformSettings();
  const reviews = await ReviewModel.find({ bookingId: booking._id, status: 'AWAITING_REVEAL' }).lean<
    ReviewRecord[]
  >();
  const all = await ReviewModel.countDocuments({ bookingId: booking._id });
  const closed = reviewWindowCloses(booking, settings.reviews.windowDays) <= now;
  if (!closed && settings.reviews.revealTogether && all < 2) return 0;
  await publish(reviews, now);
  return reviews.length;
}

/** POST /reviews: the Guest's or the Host's review of a completed trip, once each, within the window. */
export async function submitReview(
  userId: string,
  input: ReviewInput,
  now = new Date(),
): Promise<ReviewView> {
  const booking = await BookingModel.findOne({ ref: input.bookingRef.toUpperCase() }).lean<BookingRecord>();
  const direction = booking ? directionFor(booking, userId) : null;
  if (!booking || !direction) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that trip.");
  if (booking.status !== 'COMPLETED') {
    throw new HttpError(409, 'NOT_COMPLETED', 'You can review a trip once it’s completed.');
  }
  const settings = await getPlatformSettings();
  const closes = reviewWindowCloses(booking, settings.reviews.windowDays);
  if (closes <= now) throw new HttpError(409, 'REVIEW_CLOSED', 'The time to review this trip has passed.');
  const guestReview = direction === 'GUEST_TO_HOST';
  if (guestReview ? !input.cleanliness : !input.care) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      [guestReview ? 'cleanliness' : 'care']: guestReview
        ? 'Rate the car’s cleanliness and condition'
        : 'Rate how they looked after the car',
    });
  }
  const reason = moderationReason(input.body);
  let created;
  try {
    created = await ReviewModel.create({
      bookingId: booking._id,
      ...(guestReview && { vehicleId: booking.vehicleId }),
      authorId: userId,
      subjectId: guestReview ? booking.hostId : booking.guestId,
      direction,
      overall: input.overall,
      communication: input.communication,
      pickupReturn: input.pickupReturn,
      ...(guestReview ? { cleanliness: input.cleanliness } : { care: input.care }),
      ...(input.body && { body: input.body }),
      status: 'AWAITING_REVEAL',
      revealAt: closes,
      moderation: reason ? { state: 'HELD', reason, at: now } : { state: 'CLEAR' },
    });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new HttpError(409, 'ALREADY_REVIEWED', 'You’ve already reviewed this trip.');
    }
    throw error;
  }
  await revealReviews(booking._id, now);
  const fresh = await ReviewModel.findById(created._id).lean<ReviewRecord>();
  return (await toViews([fresh!], userId))[0]!;
}

/**
 * Queued when a trip completes: the review requests now, and the reveal when the window closes
 * (plan §4.3, `trip.reviewRequest` and `reviews.reveal`).
 */
export async function queueReviewJobs(booking: BookingRecord, session: ClientSession, now = new Date()) {
  const settings = await getPlatformSettings();
  const id = booking._id.toString();
  await enqueue(
    'trip.reviewRequest',
    { bookingId: id },
    { uniqueKey: `trip.reviewRequest:${id}`, refId: id, session },
  );
  await enqueue(
    'reviews.reveal',
    { bookingId: id },
    {
      runAt: new Date(now.getTime() + settings.reviews.windowDays * DAY_MS),
      uniqueKey: `reviews.reveal:${id}`,
      refId: id,
      session,
    },
  );
}

/** `trip.reviewRequest`: asks both sides to review the trip (spec §16). */
export async function requestReviews(bookingId: string): Promise<void> {
  const booking = await BookingModel.findById(bookingId).lean<BookingRecord>();
  if (!booking || booking.status !== 'COMPLETED') return;
  const settings = await getPlatformSettings();
  const closes = reviewWindowCloses(booking, settings.reviews.windowDays);
  const [guest, host] = await Promise.all([
    UserModel.findById(booking.guestId).select('firstName').lean(),
    UserModel.findById(booking.hostId).select('firstName').lean(),
  ]);
  for (const role of ['GUEST', 'HOST'] as const) {
    const me = role === 'GUEST' ? guest : host;
    const other = role === 'GUEST' ? host : guest;
    const path = role === 'GUEST' ? `/trips/${booking.ref}/review` : `/host/bookings/${booking.ref}/review`;
    if (
      await ReviewModel.exists({
        bookingId: booking._id,
        direction: role === 'GUEST' ? 'GUEST_TO_HOST' : 'HOST_TO_GUEST',
      })
    ) {
      continue;
    }
    await notify({
      userId: role === 'GUEST' ? booking.guestId : booking.hostId,
      type: 'REVIEW_REQUEST',
      title:
        role === 'GUEST'
          ? `How was the ${booking.vehicleSnapshot.title}?`
          : `How was ${other?.firstName ?? 'your guest'}?`,
      body: `Leave a review by ${closes.toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland' })}.`,
      link: path,
      email: {
        template: 'tripNotice',
        props: {
          firstName: me?.firstName ?? 'there',
          heading: role === 'GUEST' ? 'How was your trip?' : `How was ${other?.firstName ?? 'your guest'}?`,
          paragraphs: [
            role === 'GUEST'
              ? `Tell other guests about your trip in ${other?.firstName ?? 'your host'}'s ${booking.vehicleSnapshot.title}.`
              : `Tell other hosts how ${other?.firstName ?? 'your guest'} looked after your ${booking.vehicleSnapshot.title}.`,
            'Reviews are shown once you’ve both written one, or when the time to review closes, so you can be honest.',
          ],
          buttonLabel: 'Write a review',
          url: `${siteUrl()}${path}`,
        },
      },
      dedupeKey: `REVIEW_REQUEST:${booking._id.toString()}:${role}`,
    });
  }
}

/** GET /me/reviews: trips waiting for the user's review, the reviews they wrote, and those about them. */
export async function myReviews(userId: string, now = new Date()) {
  const settings = await getPlatformSettings();
  const since = new Date(now.getTime() - (settings.reviews.windowDays + 7) * DAY_MS);
  const recent = await BookingModel.find({
    $or: [{ guestId: userId }, { hostId: userId }],
    status: 'COMPLETED',
    endAt: mongoose.trusted({ $gte: since }),
  })
    .sort({ endAt: -1 })
    .lean<BookingRecord[]>();
  const mine = await ReviewModel.find({ authorId: userId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<ReviewRecord[]>();
  const others = await UserModel.find({
    _id: mongoose.trusted({
      $in: recent.map((booking) => (booking.guestId.equals(userId) ? booking.hostId : booking.guestId)),
    }),
  })
    .select('firstName avatarUrl')
    .lean();
  const toWrite = recent
    .filter((booking) => !mine.some((review) => review.bookingId.equals(booking._id)))
    .filter((booking) => reviewWindowCloses(booking, settings.reviews.windowDays) > now)
    .map((booking) => {
      const role = booking.guestId.equals(userId) ? ('GUEST' as const) : ('HOST' as const);
      const other = others.find((person) =>
        person._id.equals(role === 'GUEST' ? booking.hostId : booking.guestId),
      );
      return {
        bookingRef: booking.ref,
        role,
        otherParty: {
          firstName: other?.firstName ?? 'Former member',
          ...(other?.avatarUrl && { avatarUrl: other.avatarUrl }),
        },
        vehicleTitle: booking.vehicleSnapshot.title,
        end: booking.endAt.toISOString(),
        closesAt: reviewWindowCloses(booking, settings.reviews.windowDays).toISOString(),
      };
    });
  const received = await ReviewModel.find({ subjectId: userId, status: 'PUBLISHED' })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<ReviewRecord[]>();
  return { toWrite, written: await toViews(mine, userId), received: await toViews(received, userId) };
}

/** GET /users/{id}/reviews: a member's public profile and the published reviews about them (plan §6.2). */
export async function memberReviews(memberId: string) {
  if (!mongoose.isValidObjectId(memberId))
    throw new HttpError(404, 'NOT_FOUND', "We couldn't find that member.");
  const member = await UserModel.findById(memberId)
    .select('firstName avatarUrl createdAt identityVerification hostProfile closedAt')
    .lean();
  if (!member || member.closedAt) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that member.");
  const [guestRating] = await ReviewModel.aggregate<{ avg: number; count: number }>([
    { $match: { subjectId: member._id, direction: 'HOST_TO_GUEST', status: 'PUBLISHED' } },
    { $group: { _id: null, avg: { $avg: '$overall' }, count: { $sum: 1 } } },
  ]);
  const guestTrips = await BookingModel.countDocuments({ guestId: member._id, status: 'COMPLETED' });
  const reviews = await ReviewModel.find({ subjectId: member._id, status: 'PUBLISHED' })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean<ReviewRecord[]>();
  const host = member.hostProfile?.status === 'APPROVED' ? member.hostProfile : undefined;
  return {
    profile: {
      id: member._id.toString(),
      firstName: member.firstName,
      ...(member.avatarUrl && { avatarUrl: member.avatarUrl }),
      joinedYear: member.createdAt.getFullYear(),
      verified: member.identityVerification?.status === 'APPROVED',
      asGuest: {
        rating: { avg: Math.round((guestRating?.avg ?? 0) * 100) / 100, count: guestRating?.count ?? 0 },
        tripCount: guestTrips,
      },
      ...(host && {
        asHost: {
          rating: host.rating,
          tripCount: host.tripCount,
          ...(host.responseRate !== undefined && { responseRate: host.responseRate }),
          ...(host.bio && { bio: host.bio }),
        },
      }),
    },
    reviews: await toViews(reviews),
  };
}

/** GET /admin/reviews: reviews held for a moderator, oldest first, and recently hidden ones. */
export async function reviewsForModeration(state: 'HELD' | 'HIDDEN' = 'HELD') {
  const reviews = await ReviewModel.find({ 'moderation.state': state })
    .sort({ createdAt: state === 'HELD' ? 1 : -1 })
    .limit(100)
    .lean<ReviewRecord[]>();
  const views = await toViews(reviews);
  return views.map((view, index) => ({ ...view, moderationReason: reviews[index]!.moderation.reason ?? '' }));
}

/**
 * POST /admin/reviews/{id}/moderate: a moderator clears a held review (published if its time has come) or
 * hides one with a recorded reason, which takes it out of the ratings (plan §9: moderation).
 */
export async function moderateReview(
  staffId: string,
  reviewId: string,
  action: 'CLEAR' | 'HIDE',
  reason: string,
  ip?: string,
  now = new Date(),
) {
  if (!mongoose.isValidObjectId(reviewId)) throw new HttpError(404, 'NOT_FOUND', 'No such review.');
  const review = await ReviewModel.findById(reviewId).lean<ReviewRecord>();
  if (!review) throw new HttpError(404, 'NOT_FOUND', 'No such review.');
  const moderation = { state: action === 'CLEAR' ? 'CLEAR' : 'HIDDEN', reason, by: staffId, at: now };
  // Clearing a hidden review puts it back in line: it's published like any other once it's time.
  const status = action === 'HIDE' ? 'HIDDEN' : review.status === 'HIDDEN' ? 'AWAITING_REVEAL' : undefined;
  await ReviewModel.updateOne({ _id: review._id }, { $set: { moderation, ...(status && { status }) } });
  if (action === 'HIDE' && review.direction === 'GUEST_TO_HOST')
    await recountRatings(review.subjectId, review.vehicleId);
  if (action === 'CLEAR') await revealReviews(review.bookingId, now);
  await recordAudit({
    actorId: staffId,
    action: `review.${action === 'CLEAR' ? 'cleared' : 'hidden'}`,
    entity: 'review',
    entityId: reviewId,
    before: { status: review.status, moderation: review.moderation.state },
    after: { reason },
    ...(ip && { ip }),
  });
  const fresh = await ReviewModel.findById(review._id).lean<ReviewRecord>();
  return (await toViews([fresh!]))[0]!;
}
