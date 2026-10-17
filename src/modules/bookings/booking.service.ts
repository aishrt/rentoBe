import mongoose, { type ClientSession, type Types } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { stripe } from '../../integrations/stripe.js';
import { enqueue } from '../../jobs/queue.js';
import { formatNzDateTime } from '../../lib/format.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { randomRef } from '../../lib/refs.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  extendTripHold,
  reserveTripDates,
  tripDatesStillHeld,
} from '../availability/availability.service.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { bookingPayment } from '../payments/booking-payment.js';
import { PaymentModel, isChargedBack, type PaymentDocument } from '../payments/payment.model.js';
import { hostPartOf, tripPayoutOnCancel } from '../payouts/payouts.service.js';
import { ReviewModel } from '../reviews/review.model.js';
import { checkBookingVelocity } from '../risk/risk-signals.js';
import { alertStaff } from '../staff/staff-alerts.js';
import {
  eligibilityProblems,
  licenceProblemsForTrip,
  verificationInReview,
} from '../users/driver-licence.service.js';
import { UserModel, type Role } from '../users/user.model.js';
import { isStaff } from '../users/user.service.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { findLiveVehicle } from '../vehicles/vehicles.service.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import { BookingModel, type BookingDocument } from './booking.model.js';
import { notifyCancelled, notifyHostAccepted, notifyRequestEnded } from './booking-notifications.js';
import {
  applyPaymentIntent,
  cancelIntent,
  captureIntent,
  refundIntent,
  releaseOtherPayments,
  releasePayment,
  statusAfterRefunds,
  vehicleSuspended,
  vehicleTakesBookings,
  type RefundRecord,
} from './booking-payments.js';
import { endBooking } from './booking-transitions.js';
import {
  awaitsVerification,
  hostAnswers,
  loadBookingContext,
  toBookingView,
  type BookingRecord,
  type Viewer,
} from './booking-view.js';
import type {
  AdminCancellationPreview,
  AdminCancelReason,
  BookingView,
  CancellationPreview,
  CreateBookingInput,
  VerificationOutcome,
} from './bookings.schemas.js';
import {
  guestCancellation,
  hostCancellation,
  noCharge,
  platformCancellation,
  type CancellationOutcome,
} from './policies.js';
import { evaluateTrip, tripProblemError } from './trip.service.js';

/*
 * The booking lifecycle (plan §8.2): creating a booking and holding its dates, the Host's answer to
 * a request, cancellations with the policy engine's refund, and the expiry of unpaid holds and
 * unanswered requests. Every status change goes through booking-transitions.ts.
 */

const MINUTE_MS = 60_000;
/** How long a payment still processing at the bank keeps its dates: past the next check, 5 minutes on. */
const PROCESSING_HOLD_MS = 15 * MINUTE_MS;
/** A signed-in Guest's dates are held for 30 minutes while they pay (plan §8.2). */
export const PAYMENT_HOLD_MINUTES = 30;

const notFound = () => new HttpError(404, 'NOT_FOUND', "We couldn't find that booking.");
const record = (booking: BookingDocument) => booking.toObject() as BookingRecord;

export interface Actor {
  userId: string;
  roles: readonly Role[];
}

/** A booking the actor can see, by its reference (RV-7K2Q9M) or id, and how they see it. */
export async function findBookingFor(
  actor: Actor,
  refOrId: string,
): Promise<{ booking: BookingDocument; viewer: Viewer }> {
  const booking = /^RV-[A-Z0-9]{6}$/i.test(refOrId)
    ? await BookingModel.findOne({ ref: refOrId.toUpperCase() })
    : mongoose.isValidObjectId(refOrId)
      ? await BookingModel.findById(refOrId)
      : null;
  if (!booking) throw notFound();
  if (booking.guestId.equals(actor.userId)) return { booking, viewer: 'GUEST' };
  if (booking.hostId.equals(actor.userId)) return { booking, viewer: 'HOST' };
  if (isStaff(actor.roles)) return { booking, viewer: 'STAFF' };
  throw notFound();
}

export async function bookingView(booking: BookingDocument, viewer: Viewer): Promise<BookingView> {
  return toBookingView(record(booking), await loadBookingContext(record(booking)), viewer);
}

/**
 * POST /bookings (spec §7, steps 1–7): checks the Guest and the trip, then creates the booking with
 * its dates held for 30 minutes while the Guest pays. The same request again returns the same
 * booking, so a double click never holds twice.
 */
export async function createBooking(
  guestId: string,
  input: CreateBookingInput,
  now = new Date(),
): Promise<BookingDocument> {
  const guest = await UserModel.findById(guestId);
  if (!guest || guest.status !== 'ACTIVE' || guest.closedAt) throw unauthenticated();
  const vehicle = await findLiveVehicle(input.vehicleId);
  if (vehicle.hostId.equals(guest._id)) {
    throw new HttpError(409, 'OWN_CAR', "You can't book your own car.");
  }
  const host = await UserModel.findById(vehicle.hostId).select('status hostProfile blockedUserIds');
  if (!host || host.status !== 'ACTIVE' || host.hostProfile?.status !== 'APPROVED') {
    throw new HttpError(409, 'NOT_BOOKABLE', "This car can't be booked right now.");
  }
  if (host.blockedUserIds.some((id) => id.equals(guest._id))) {
    throw new HttpError(403, 'NOT_BOOKABLE', "This car can't be booked right now.");
  }

  // The Guest's own unfinished checkout for this car: the same request again returns it, and a
  // changed one replaces it, so their own hold never blocks them.
  const previous = await BookingModel.findOne({
    guestId: guest._id,
    vehicleId: vehicle._id,
    status: 'PAYMENT_PENDING',
    holdExpiresAt: mongoose.trusted({ $gt: now }),
  }).sort({ createdAt: -1 });

  const settings = await getPlatformSettings();
  const trip = await evaluateTrip(vehicle, input, {
    settings,
    hostGstRegistered: host.hostProfile?.gstRegistered ?? false,
    now,
    ...(previous && { ignoreBookingId: previous._id }),
  });
  if (trip.problems.length > 0) throw tripProblemError(trip.problems[0]!);

  // Verification at checkout (plan §6.1, §8.2): mobile, licence and the identity check. A check in review
  // turns an Instant Book into a request.
  const problems = eligibilityProblems(guest, settings, trip.endAt, now, trip.startAt);
  if (problems.length > 0) {
    throw new HttpError(409, 'VERIFICATION_REQUIRED', problems[0]!.message, {
      verification: problems.map((problem) => problem.code).join(','),
    });
  }

  const pickupOptionId = trip.pickup._id;
  const returnOptionId = trip.dropoff._id;
  const sameOption = (a?: Types.ObjectId, b?: Types.ObjectId) => String(a ?? '') === String(b ?? '');
  if (
    previous &&
    previous.startAt.getTime() === trip.startAt.getTime() &&
    previous.endAt.getTime() === trip.endAt.getTime() &&
    previous.price.totalCents === trip.quote.price.totalCents &&
    sameOption(previous.pickupOptionId, pickupOptionId) &&
    sameOption(previous.returnOptionId, returnOptionId)
  ) {
    return previous;
  }
  const previousPayment = previous
    ? await PaymentModel.findOne({ bookingId: previous._id, type: 'BOOKING' }).sort({ createdAt: -1 })
    : null;

  const holdExpiresAt = new Date(now.getTime() + PAYMENT_HOLD_MINUTES * MINUTE_MS);
  const photo = vehicle.photos.find(
    (candidate) => candidate.status === 'APPROVED' && candidate.type === 'FRONT',
  );

  for (let attempt = 0; ; attempt += 1) {
    const ref = randomRef('RV');
    try {
      const created = await withTransaction(async (session) => {
        if (previous) {
          await endBooking(
            previous,
            { to: 'EXPIRED', from: ['PAYMENT_PENDING'], reason: 'Replaced by a new checkout', now },
            session,
          );
        }
        const [booking] = await BookingModel.create(
          [
            {
              ref,
              vehicleId: vehicle._id,
              guestId: guest._id,
              hostId: vehicle.hostId,
              startAt: trip.startAt,
              endAt: trip.endAt,
              ...(pickupOptionId && { pickupOptionId }),
              ...(trip.pickupAddress && { pickupAddress: trip.pickupAddress }),
              ...(returnOptionId && { returnOptionId }),
              ...(trip.returnAddress && { returnAddress: trip.returnAddress }),
              ...(trip.plan && {
                protectionPlan: {
                  code: trip.plan.code,
                  name: trip.plan.name,
                  priceCents: trip.quote.price.protectionCents,
                  excessCents: trip.plan.excessCents,
                  coverSummary: trip.plan.coverSummary,
                  mandatory: trip.plan.mandatory,
                },
              }),
              status: 'PAYMENT_PENDING',
              instantBook: vehicle.rules.instantBook,
              holdExpiresAt,
              vehicleSnapshot: {
                title: vehicleTitle(vehicle),
                photoUrl: photo?.url,
                regoPlate: vehicle.regoPlate,
              },
              terms: {
                fuelPolicy: vehicle.fuelPolicy,
                kmAllowancePerDay: vehicle.unlimitedKm ? undefined : vehicle.kmAllowancePerDay,
                unlimitedKm: vehicle.unlimitedKm,
                extraKmCents: vehicle.pricing?.extraKmCents ?? 0,
              },
              price: trip.quote.price,
              lineItems: trip.quote.lineItems,
              cancellationPolicy: trip.tier.code,
              cancellationTerms: trip.tier,
              statusHistory: [{ status: 'PAYMENT_PENDING', at: now, by: guest._id }],
            },
          ],
          { session },
        );
        await reserveTripDates(
          {
            vehicleId: vehicle._id,
            bookingId: booking!._id,
            startAt: trip.startAt,
            endAt: trip.endAt,
            bufferHours: vehicle.rules.bufferHours,
            holdUntil: holdExpiresAt,
          },
          session,
          now,
        );
        await enqueue(
          'booking.expirePaymentHold',
          { bookingId: booking!.id },
          { runAt: holdExpiresAt, uniqueKey: `expire-hold:${booking!.id}`, refId: booking!.id, session },
        );
        return booking!;
      });
      // The replaced checkout's payment can no longer be used.
      if (previousPayment) await cancelIntent(previousPayment).catch(() => undefined);
      // Many bookings in a day goes to the admins' risk queue (plan §14); it never stops this one.
      await checkBookingVelocity(guest._id, now).catch(() => undefined);
      return created;
    } catch (error) {
      // Two bookings drew the same reference; draw again.
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000 && attempt < 3) continue;
      throw error;
    }
  }
}

const GROUP_FILTERS: Record<string, (now: Date) => Record<string, unknown>> = {
  upcoming: (now) => ({
    $or: [{ status: 'PENDING' }, { status: 'CONFIRMED', startAt: mongoose.trusted({ $gt: now }) }],
  }),
  current: (now) => ({
    $or: [{ status: 'ACTIVE' }, { status: 'CONFIRMED', startAt: mongoose.trusted({ $lte: now }) }],
  }),
  completed: () => ({ status: 'COMPLETED' }),
  cancelled: () => ({ status: mongoose.trusted({ $in: ['CANCELLED', 'DECLINED', 'EXPIRED'] }) }),
  // What the Host still has to answer: not an Instant Book waiting for the Guest's verification, nor
  // a request they've already accepted (both show under Upcoming).
  requests: () => ({
    status: 'PENDING',
    instantBook: false,
    hostAcceptedAt: mongoose.trusted({ $exists: false }),
  }),
};

/**
 * A checkout the Guest never paid for expires without the Host ever hearing of it, so it stays out of
 * the Host's lists. A request that ran out of time has its deadline, and belongs there.
 */
const REACHED_THE_HOST = {
  $or: [
    { status: mongoose.trusted({ $ne: 'EXPIRED' }) },
    { requestExpiresAt: mongoose.trusted({ $exists: true }) },
  ],
};

/**
 * The Guest's Cancelled trips leave out checkouts they left or replaced (nothing was paid, plan §8.2), but keep
 * a request that expired and a payment that went through and was given back.
 */
const GUEST_SAW_IT = {
  $or: [...REACHED_THE_HOST.$or, { paymentReturnedAt: mongoose.trusted({ $exists: true }) }],
};

/**
 * GET /bookings: a Guest's trips or a Host's bookings, grouped as in plan §8.2 (dashboard grouping), a page
 * at a time (`skip`, `limit`).
 */
export async function listBookings(
  userId: string,
  role: 'guest' | 'host',
  group?: string,
  now = new Date(),
  { skip = 0, limit = 100 }: { skip?: number; limit?: number } = {},
) {
  const owner = role === 'guest' ? { guestId: userId } : { hostId: userId };
  const grouped =
    group && GROUP_FILTERS[group]
      ? GROUP_FILTERS[group]!(now)
      : { status: mongoose.trusted({ $ne: 'PAYMENT_PENDING' }) };
  const filter = { ...owner, $and: [grouped, role === 'host' ? REACHED_THE_HOST : GUEST_SAW_IT] };
  const ascending = group === 'upcoming' || group === 'requests';
  // The id settles ties, so the pages never overlap.
  const bookings = await BookingModel.find(filter)
    .sort({ startAt: ascending ? 1 : -1, _id: ascending ? 1 : -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  const others = await UserModel.find({
    _id: mongoose.trusted({
      $in: bookings.map((booking) => (role === 'guest' ? booking.hostId : booking.guestId)),
    }),
  })
    .select('firstName avatarUrl identityVerification.status')
    .lean();
  const vehicles = await VehicleModel.find({
    _id: mongoose.trusted({ $in: bookings.map((booking) => booking.vehicleId) }),
  })
    .select('slug')
    .lean();
  // A Host answers a request from the list: the Guest's verification, rating and trips (plan §9, Days 16–19).
  const guestStats = role === 'host' ? await guestStatsFor(others.map((other) => other._id)) : null;

  return bookings.map((booking) => {
    const other = others.find((candidate) =>
      candidate._id.equals(role === 'guest' ? booking.hostId : booking.guestId),
    );
    return {
      id: booking._id.toString(),
      ref: booking.ref,
      status: booking.status,
      instantBook: booking.instantBook,
      vehicle: {
        slug: vehicles.find((vehicle) => vehicle._id.equals(booking.vehicleId))?.slug ?? '',
        title: booking.vehicleSnapshot.title,
        ...(booking.vehicleSnapshot.photoUrl && { photoUrl: booking.vehicleSnapshot.photoUrl }),
      },
      start: booking.startAt.toISOString(),
      end: booking.endAt.toISOString(),
      otherParty: {
        firstName: other?.firstName ?? 'Former member',
        ...(other?.avatarUrl && { avatarUrl: other.avatarUrl }),
        ...(guestStats && {
          verified: other?.identityVerification?.status === 'APPROVED',
          rating: guestStats.rating.get(other?._id.toString() ?? '') ?? { avg: 0, count: 0 },
          tripCount: guestStats.trips.get(other?._id.toString() ?? '') ?? 0,
        }),
      },
      amountCents: role === 'guest' ? booking.price.totalCents : booking.price.hostPayoutCents,
      ...(booking.status === 'PENDING' &&
        booking.requestExpiresAt && { requestExpiresAt: booking.requestExpiresAt.toISOString() }),
      ...(booking.verificationReview && { verificationReview: booking.verificationReview.status }),
      ...(booking.status === 'PENDING' && booking.hostAcceptedAt && { hostAccepted: true }),
    };
  });
}

/** Guests' published ratings from Hosts and their completed trips, for the Host's booking lists (plan §6.2). */
async function guestStatsFor(guestIds: Types.ObjectId[]) {
  const [ratings, trips] = await Promise.all([
    ReviewModel.aggregate<{ _id: Types.ObjectId; avg: number; count: number }>([
      {
        $match: {
          subjectId: { $in: guestIds },
          direction: 'HOST_TO_GUEST',
          status: 'PUBLISHED',
        },
      },
      { $group: { _id: '$subjectId', avg: { $avg: '$overall' }, count: { $sum: 1 } } },
    ]),
    BookingModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { guestId: { $in: guestIds }, status: 'COMPLETED' } },
      { $group: { _id: '$guestId', count: { $sum: 1 } } },
    ]),
  ]);
  return {
    rating: new Map(
      ratings.map((row) => [row._id.toString(), { avg: Math.round(row.avg * 100) / 100, count: row.count }]),
    ),
    trips: new Map(trips.map((row) => [row._id.toString(), row.count])),
  };
}

/**
 * The share of requests a Host answered before they expired, shown to Guests (plan §6.2). A request
 * the Host accepted counts as answered even if the Guest's verification then stopped it, and one that
 * ended because the Guest wasn't verified, or that support cancelled, before the Host answered, isn't
 * counted at all.
 */
export async function updateResponseRate(hostId: Types.ObjectId) {
  const [row] = await BookingModel.aggregate<{ total: number; expired: number }>([
    {
      $match: {
        hostId,
        instantBook: false,
        'statusHistory.status': 'PENDING',
        status: { $nin: ['PENDING', 'PAYMENT_PENDING'] },
        cancellationReason: { $ne: 'REQUEST_WITHDRAWN' },
        $or: [{ 'verificationReview.status': { $ne: 'REJECTED' } }, { hostAcceptedAt: { $exists: true } }],
        $nor: [
          {
            cancellationReason: 'PLATFORM',
            hostAcceptedAt: { $exists: false },
            'statusHistory.status': { $ne: 'CONFIRMED' },
          },
        ],
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        expired: {
          $sum: {
            $cond: [
              {
                $and: [{ $eq: ['$status', 'EXPIRED'] }, { $not: [{ $ifNull: ['$hostAcceptedAt', false] }] }],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  if (!row || row.total === 0) return;
  await UserModel.updateOne(
    { _id: hostId },
    { $set: { 'hostProfile.responseRate': Math.round((100 * (row.total - row.expired)) / row.total) } },
  );
}

const notARequest = () =>
  new HttpError(
    409,
    'NOT_A_REQUEST',
    "This booking is waiting for the guest's identity check, not for your answer.",
  );

/** A Guest whose account is suspended or closed isn't charged (plan §8.2, user suspended). */
const guestOnHold = (guest: { status: string; closedAt?: Date } | null) =>
  !guest || guest.status !== 'ACTIVE' || Boolean(guest.closedAt);

const guestSuspended = () =>
  new HttpError(
    409,
    'GUEST_SUSPENDED',
    "This guest's account is on hold, so the request can't be accepted. Our team will be in touch.",
  );

/**
 * Staff hear of a booking that can't be confirmed because its Guest's account is on hold (plan §8.2: their
 * upcoming bookings are the admin's to cancel or let go ahead), once for each booking. A request the Host
 * tried to accept meanwhile isn't recorded as accepted (acceptBooking refuses it first), so lifting the
 * suspension doesn't confirm it: the Host has to accept it again before it expires.
 */
async function alertGuestOnHold(
  booking: Pick<BookingDocument, 'id' | 'ref' | 'instantBook' | 'hostAcceptedAt' | 'requestExpiresAt'>,
) {
  const accepted = booking.instantBook || Boolean(booking.hostAcceptedAt);
  const expires = booking.requestExpiresAt
    ? ` before the request expires (at ${formatNzDateTime(booking.requestExpiresAt)} NZ time)`
    : ' before the request expires';
  await alertStaff({
    type: 'GUEST_SUSPENDED_BOOKING',
    title: `${booking.ref} not confirmed: the guest's account is on hold`,
    body: accepted
      ? `booking ${booking.ref} was ready to confirm, but the guest's account is suspended or closed, so their card wasn't charged. Cancel it from the booking, or lift the suspension if it can go ahead: it's then confirmed.`
      : `the host tried to accept booking ${booking.ref}, but the guest's account is suspended or closed, so their card wasn't charged and the acceptance wasn't recorded. Cancel it from the booking, or lift the suspension if it can go ahead: the host then has to accept it again${expires}. Otherwise it expires and the card hold is released.`,
    link: `/admin/bookings/${booking.ref}`,
    dedupeKey: `GUEST_SUSPENDED_BOOKING:${booking.id}`,
  });
}

/**
 * POST /bookings/{id}/accept: the Host accepts a request; the authorisation is captured (plan §8.1).
 * While the Guest's verification is still in review, the acceptance is recorded and the booking is
 * confirmed when support approves the check (plan §8.2): that's checked again here, as the Guest's licence
 * may have gone back to support since they booked. 409 GUEST_SUSPENDED while the Guest's account is on hold.
 */
export async function acceptBooking(
  booking: BookingDocument,
  hostId: string,
  now = new Date(),
): Promise<BookingDocument> {
  if (booking.status !== 'PENDING')
    throw new HttpError(409, 'NOT_PENDING', 'This request has already been answered.');
  if (booking.instantBook) throw notARequest();
  // Accepted already: it waits for support to approve the Guest's verification. Once nothing else blocks it,
  // accepting again captures the payment, if Stripe couldn't be reached to capture it before.
  if (booking.hostAcceptedAt && booking.verificationReview?.status === 'PENDING') return booking;
  // Too late once the trip has started (plan §8.2): the request ends now, and the card hold is released, unless
  // the capture had gone through after all, which confirmed it.
  if (booking.startAt <= now) {
    await expireRequest(booking.id, now, { force: true });
    const fresh = await BookingModel.findById(booking._id);
    if (fresh?.status === 'CONFIRMED') return fresh;
    throw tripStarted('request');
  }
  if (!booking.requestExpiresAt || booking.requestExpiresAt <= now) {
    throw new HttpError(409, 'REQUEST_EXPIRED', 'This request has expired.');
  }
  // A suspended car takes no new bookings (plan §8.2): the request waits for staff, or expires.
  if (!(await vehicleTakesBookings(booking.vehicleId))) throw vehicleSuspended();
  // Nor is a suspended Guest charged: staff cancel each of their bookings or let it go ahead (plan §8.2).
  const guest = await UserModel.findById(booking.guestId)
    .select('status closedAt identityVerification driverLicence')
    .lean();
  if (!guest || guestOnHold(guest)) {
    await alertGuestOnHold(booking);
    throw guestSuspended();
  }
  // The Guest's verification went back to support since they booked (changed licence details, say): the
  // request waits for it, as one made meanwhile does.
  if (
    booking.verificationReview?.status !== 'PENDING' &&
    verificationInReview(guest, await getPlatformSettings())
  ) {
    const held = await BookingModel.findOneAndUpdate(
      { _id: booking._id, status: 'PENDING' },
      { $set: { verificationReview: { status: 'PENDING' } } },
      { new: true },
    );
    if (!held) throw new HttpError(409, 'NOT_PENDING', 'This request has already been answered.');
    booking = held;
    if (booking.hostAcceptedAt) return booking;
  }

  if (booking.verificationReview?.status === 'PENDING' && !booking.hostAcceptedAt) {
    const accepted = await withTransaction(async (session) => {
      const updated = await BookingModel.findOneAndUpdate(
        { _id: booking._id, status: 'PENDING', hostAcceptedAt: mongoose.trusted({ $exists: false }) },
        { $set: { hostAcceptedAt: now } },
        { new: true, session },
      );
      // Support may have approved the check a moment ago: then nothing is left to wait for.
      if (updated?.verificationReview?.status === 'PENDING') {
        await notifyHostAccepted(record(updated), await loadBookingContext(record(updated)), { session });
      }
      return updated;
    });
    if (accepted && accepted.verificationReview?.status !== 'PENDING') await capturePending(accepted, now);
  } else {
    await capturePending(booking, now);
  }
  await recordAudit({ actorId: hostId, action: 'booking.accepted', entity: 'booking', entityId: booking.id });
  await updateResponseRate(booking.hostId);
  return (await BookingModel.findById(booking._id))!;
}

/** The trip has started: a request or a booking waiting for verification can't be confirmed (plan §8.2). */
const tripStarted = (what: 'request' | 'booking') =>
  new HttpError(
    409,
    'TRIP_STARTED',
    what === 'request'
      ? "The trip's start time has passed, so this request can't be accepted any more. The guest's card hold is released."
      : "The trip's start time has passed, so this booking can't be confirmed any more. The guest's card hold is released.",
  );

/** The codes capturePending() ends a booking with: its authorisation is released, not captured. */
const ENDED_UNCAPTURED = ['PAYMENT_EXPIRED', 'TRIP_STARTED'];
/** The codes it leaves a booking waiting with: Stripe's webhook, a retry or the request's expiry settles it. */
const CAPTURE_UNSETTLED = ['PAYMENTS_UNAVAILABLE', 'CAPTURE_FAILED'];

/**
 * Captures a pending booking's authorisation, which confirms it. An authorisation that can no longer be
 * captured, or a trip that has already started, ends the booking instead (plan §8.1, item 14). A capture
 * whose result isn't known (Stripe unreachable) ends nothing: it may have gone through, so its webhook
 * confirms the booking, or trying again captures it (the idempotency key never captures twice).
 */
async function capturePending(booking: BookingDocument, now: Date): Promise<void> {
  if (booking.startAt <= now) {
    await expireRequest(booking.id, now, { force: true });
    // Stripe had captured it already: then it's confirmed.
    if ((await BookingModel.findById(booking._id).select('status').lean())?.status === 'CONFIRMED') return;
    throw tripStarted('booking');
  }
  const found = await bookingPayment(booking);
  const payment = found?.status === 'AUTHORISED' ? found : null;
  if (!payment)
    throw new HttpError(
      409,
      'NOT_AUTHORISED',
      "The guest's payment isn't authorised. Please contact support.",
    );

  let intent: Stripe.PaymentIntent;
  try {
    intent = await captureIntent(payment);
  } catch (error) {
    if (
      !(error instanceof Stripe.errors.StripeCardError) &&
      !(error instanceof Stripe.errors.StripeInvalidRequestError)
    ) {
      throw new HttpError(
        503,
        'PAYMENTS_UNAVAILABLE',
        "We couldn't reach our payment provider to take the guest's payment. Please try again in a moment.",
      );
    }
    // Stripe refused the capture. It may have been captured already; otherwise the authorisation lapsed or
    // was released, and the request can't go ahead.
    const current = await stripe()
      .paymentIntents.retrieve(payment.stripePaymentIntentId)
      .catch(() => null);
    if (current?.status === 'succeeded') {
      intent = current;
    } else if (!current || current.status === 'requires_capture' || current.status === 'processing') {
      throw new HttpError(
        409,
        'CAPTURE_FAILED',
        "The guest's payment couldn't be taken just now. Please try again, or contact support.",
        { reason: error.message },
      );
    } else {
      await expireRequest(booking.id, now, { force: true });
      throw new HttpError(
        409,
        'PAYMENT_EXPIRED',
        "The guest's card authorisation has lapsed, so this request has expired.",
        { reason: error.message },
      );
    }
  }
  await withTransaction((session) => applyPaymentIntent(intent, session, now));
}

/** Staff hear of a capture that couldn't be settled while confirming bookings in bulk; the others go on. */
async function captureUnsettled(booking: BookingDocument, error: HttpError) {
  await alertStaff({
    type: 'CAPTURE_UNSETTLED',
    title: `Payment for ${booking.ref} not taken yet`,
    body: `booking ${booking.ref} is ready to confirm, but the guest's payment couldn't be taken (${error.message}). It's confirmed if Stripe took it; otherwise it's released when the request expires. Contact the guest if it doesn't go ahead.`,
    link: `/admin/bookings/${booking.ref}`,
    dedupeKey: `CAPTURE_UNSETTLED:${booking.id}`,
  });
}

/**
 * A suspension lifted (a car's, its Host's, or its Guest's): bookings that waited only for it, with the Guest's
 * check approved and the Host's answer given (or Instant Book), are captured and confirmed while their time
 * lasts. One whose Guest's account is on hold stays for staff to decide (plan §8.2), and they hear of it.
 */
export async function confirmAfterSuspension(
  filter: { vehicleId: Types.ObjectId } | { hostId: Types.ObjectId } | { guestId: Types.ObjectId },
  now = new Date(),
): Promise<string[]> {
  const ready = await BookingModel.find({
    ...filter,
    status: 'PENDING',
    'verificationReview.status': 'APPROVED',
    requestExpiresAt: mongoose.trusted({ $gt: now }),
    startAt: mongoose.trusted({ $gt: now }),
    $or: [{ instantBook: true }, { hostAcceptedAt: mongoose.trusted({ $exists: true }) }],
  });
  const confirmed: string[] = [];
  for (const booking of ready) {
    if (!(await vehicleTakesBookings(booking.vehicleId))) continue;
    if (guestOnHold(await UserModel.findById(booking.guestId).select('status closedAt').lean())) {
      await alertGuestOnHold(booking);
      continue;
    }
    try {
      await capturePending(booking, now);
      confirmed.push(booking.ref);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (CAPTURE_UNSETTLED.includes(error.code)) await captureUnsettled(booking, error);
      else if (!ENDED_UNCAPTURED.includes(error.code)) throw error;
    }
  }
  return confirmed;
}

/** POST /bookings/{id}/decline: the Host declines; the authorisation is released, with no fee (plan §8.2). */
export async function declineBooking(
  booking: BookingDocument,
  hostId: string,
  reason?: string,
): Promise<BookingDocument> {
  if (booking.status !== 'PENDING' || booking.hostAcceptedAt)
    throw new HttpError(409, 'NOT_PENDING', 'This request has already been answered.');
  if (booking.instantBook) throw notARequest();
  const payment = await bookingPayment(booking);
  // Captured a moment ago (a double click on Accept): the booking is confirmed, not declined.
  if ((await releasePayment(payment)) !== 'released') throw justChanged('PENDING', 'HOST');
  const declined = await withTransaction(async (session) => {
    const ended = await endBooking(
      booking,
      { to: 'DECLINED', from: ['PENDING'], by: hostId, reason },
      session,
    );
    if (!ended) return null;
    if (payment) await markReleased(payment, session);
    await notifyRequestEnded(record(ended), await loadBookingContext(record(ended)), 'DECLINED', { session });
    return ended;
  });
  if (declined) await releaseOtherPayments(booking, payment);
  await updateResponseRate(booking.hostId);
  return declined ?? (await BookingModel.findById(booking._id))!;
}

/** A released payment is recorded as cancelled, unless it's already recorded as taken (plan §8.1, item 14). */
const markReleased = (payment: PaymentDocument, session: ClientSession) =>
  PaymentModel.updateOne(
    { _id: payment._id, status: mongoose.trusted({ $in: ['PENDING', 'AUTHORISED', 'FAILED'] }) },
    { $set: { status: 'CANCELLED' } },
    { session },
  );

/**
 * Stripe took the payment a moment ago (the Host accepted, or 3-D Secure finished), so the booking moved on
 * instead of ending (plan §8.1, item 14).
 */
/** The trip's payout is being sent this moment: a cancellation waits for it (plan §8.1, items 15 and 16). */
const payoutInFlight = () =>
  new HttpError(409, 'PAYOUT_IN_FLIGHT', 'The Host’s payout is being sent right now. Try again in a minute.');

const justChanged = (status: BookingDocument['status'], by: 'GUEST' | 'HOST' | 'SUPPORT' = 'GUEST') =>
  new HttpError(
    409,
    'ALREADY_CHANGED',
    status === 'PAYMENT_PENDING'
      ? 'The payment went through a moment ago, so this booking has moved on. Please refresh to see it.'
      : by === 'HOST'
        ? 'This request was accepted a moment ago, so it can’t be declined. Please refresh.'
        : 'This request was accepted and paid for a moment ago. Please refresh: it can still be cancelled under the cancellation policy.',
  );

/** An earlier Host-funded refund whose Host share a cancellation lowers (plan §8.1, item 15). */
interface RefundRelief {
  refundId: Types.ObjectId;
  /** What the Host still pays for it. */
  hostCents: number;
  /** What the cancellation took off their share of it. */
  reliefCents: number;
}

/** A cancellation's outcome once the payment's earlier refunds are counted. */
interface PaidOutcome extends CancellationOutcome {
  /** Refunds already made on the payment (staff may part-refund a confirmed trip), failed ones aside. */
  earlierRefundCents: number;
  /** The policy's refund, before the earlier refunds came off it. */
  policyRefundCents: number;
  /** Earlier Host-funded refunds whose Host share the cancellation lowers, and what that comes to in all. */
  reliefs: RefundRelief[];
  reliefCents: number;
  /**
   * Staff cancelling a booking whose payment is in a chargeback (plan §8.1, item 12): nothing is refunded or kept,
   * as the dispute decides the money, and the Host is settled as for a full refund.
   */
  disputed?: boolean;
}

/**
 * Earlier refunds come off what a cancellation can still give back (plan §8.1, items 10 and 15): the refund
 * is the policy's, up to what's left of the payment, and what's kept is what the Guest has still paid after
 * it. One the platform funded is its own cost, so the Host's share of the kept fee stays the policy's. One the
 * Host funded is "a policy refund of rental the Host would otherwise receive", so the Host's net from the
 * booking is their share of the kept fee less their share of those refunds, and never below nothing:
 * - the part of the earlier refunds the policy's refund would have given back anyway (what the cap on the
 *   refund absorbed, shared among them pro rata) costs the Host nothing: all of it for a Host or platform
 *   cancellation or a 100 % tier;
 * - what's left for the Host to pay never goes past their share of the kept fee: if it would, the two cancel
 *   out, and the Host gets no share and pays nothing more.
 * Each refund's new Host share is recorded on it at cancellation, so earnings, the booking page and payouts
 * use the same figure.
 */
function afterEarlierRefunds(outcome: CancellationOutcome, payment: PaymentDocument | null): PaidOutcome {
  const live = (payment?.refunds ?? []).filter((refund) => refund.status !== 'FAILED');
  const earlierRefundCents = live.reduce((sum, refund) => sum + refund.amountCents, 0);
  if (!payment || earlierRefundCents === 0) {
    return {
      ...outcome,
      earlierRefundCents,
      policyRefundCents: outcome.refundCents,
      reliefs: [],
      reliefCents: 0,
    };
  }
  const left = Math.max(0, payment.amountCents - earlierRefundCents);
  const refundCents = Math.min(outcome.refundCents, left);
  const absorbed = Math.min(earlierRefundCents, outcome.refundCents - refundCents);
  let parts = live
    .filter((refund) => refund.fundedBy === 'HOST' && refund.kind !== 'CANCELLATION' && refund._id)
    .map((refund) => {
      const was = hostPartOf(refund);
      return {
        refundId: refund._id!,
        was,
        now: Math.round((was * (earlierRefundCents - absorbed)) / earlierRefundCents),
      };
    });
  let hostShareCents = outcome.hostShareCents;
  const stillOwed = parts.reduce((sum, part) => sum + part.now, 0);
  if (stillOwed > 0 && stillOwed >= hostShareCents) {
    hostShareCents = 0;
    parts = parts.map((part) => ({ ...part, now: 0 }));
  }
  const reliefs = parts
    .filter((part) => part.now < part.was)
    .map((part) => ({ refundId: part.refundId, hostCents: part.now, reliefCents: part.was - part.now }));
  return {
    ...outcome,
    refundCents,
    feeCents: left - refundCents,
    hostShareCents,
    earlierRefundCents,
    policyRefundCents: outcome.refundCents,
    reliefs,
    reliefCents: reliefs.reduce((sum, relief) => sum + relief.reliefCents, 0),
  };
}

/**
 * A confirmed trip whose start time has passed (plan §8.2): a Guest who cancels now hasn't turned up, so it's
 * a Guest cancellation at the start time, like a no-show; the Host can't cancel it any more, as a Host no-show
 * is one only once support confirms it.
 */
const afterStart = (booking: BookingDocument, now: Date) =>
  booking.status === 'CONFIRMED' && booking.startAt <= now;

const hostTripStarted = () =>
  new HttpError(
    409,
    'TRIP_STARTED',
    "The trip's start time has passed, so it can't be cancelled here. If the guest hasn't turned up, or you can't provide the car, contact support.",
  );

/**
 * The booking's payment is in a chargeback (plan §8.1, item 12): Stripe refuses a refund of it and the dispute
 * decides the money, so only support can cancel the booking (adminOutcome).
 */
const paymentDisputed = () =>
  new HttpError(
    409,
    'PAYMENT_DISPUTED',
    "This booking's payment is in a card dispute, so it can't be cancelled here. Please contact support.",
  );

/** Whether a paid booking's payment is in a chargeback (isChargedBack). */
async function inChargeback(booking: BookingDocument): Promise<boolean> {
  if (booking.status !== 'CONFIRMED' && booking.status !== 'ACTIVE') return false;
  return isChargedBack(await bookingPayment(booking));
}

/** What a cancellation would do, for the actor's role (plan §11: cancellation-preview). */
async function outcomeFor(booking: BookingDocument, viewer: Viewer, now: Date): Promise<PaidOutcome | null> {
  const settings = await getPlatformSettings();
  let outcome: CancellationOutcome | null = null;
  if (viewer === 'GUEST') {
    if (booking.status === 'PAYMENT_PENDING') outcome = noCharge('ABANDON_CHECKOUT', booking, now);
    if (booking.status === 'PENDING') outcome = noCharge('WITHDRAW_REQUEST', booking, now);
    if (booking.status === 'CONFIRMED') {
      outcome = guestCancellation(booking, settings, afterStart(booking, now) ? booking.startAt : now);
    }
  }
  if (viewer === 'HOST' && booking.status === 'CONFIRMED' && !afterStart(booking, now)) {
    outcome = hostCancellation(booking, settings, now);
  }
  if (!outcome) return null;
  return afterEarlierRefunds(outcome, booking.status === 'CONFIRMED' ? await bookingPayment(booking) : null);
}

const formatDollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** A booking payment that went through, perhaps already refunded in part. */
const isPaid = (status: string) => status === 'SUCCEEDED' || status === 'PARTIALLY_REFUNDED';

export async function cancellationPreview(
  booking: BookingDocument,
  viewer: Viewer,
  now = new Date(),
): Promise<CancellationPreview> {
  const outcome = await outcomeFor(booking, viewer, now);
  const refused = (message: string): CancellationPreview => ({
    allowed: false,
    kind: null,
    refundCents: 0,
    feeCents: 0,
    hostShareCents: 0,
    hostFeeCents: 0,
    refundPct: 0,
    hoursBeforeStart: 0,
    message,
  });
  if (!outcome || outcome.kind === 'PLATFORM_CANCELLATION') {
    return refused(
      viewer === 'HOST' && booking.status === 'PENDING'
        ? 'Decline the request instead: declining carries no fee.'
        : viewer === 'HOST' && afterStart(booking, now)
          ? hostTripStarted().message
          : "This booking can't be cancelled here. Please contact support.",
    );
  }
  // The dialog says so, instead of offering a refund Stripe would refuse.
  if (await inChargeback(booking)) return refused(paymentDisputed().message);
  const policy = booking.cancellationTerms
    ? `the ${booking.cancellationTerms.name} policy`
    : 'the cancellation policy';
  // Refunds staff made earlier come off what goes back now; everything already back leaves nothing to refund.
  const allBack =
    outcome.earlierRefundCents > 0 && outcome.refundCents === 0 && outcome.policyRefundCents > 0;
  const earlier =
    outcome.earlierRefundCents === 0 || allBack
      ? ''
      : viewer === 'GUEST'
        ? ` You’ve already had ${formatDollars(outcome.earlierRefundCents)} back${outcome.refundCents < outcome.policyRefundCents ? `, which comes off the ${formatDollars(outcome.policyRefundCents)} the policy gives back` : ''}.`
        : ` ${formatDollars(outcome.earlierRefundCents)} was already refunded to the guest.`;
  const hostFee =
    outcome.hostFeeCents > 0
      ? ` A Host cancellation fee of ${formatDollars(outcome.hostFeeCents)} comes off your next payout.`
      : '';
  // After the pick-up time it counts as not turning up (plan §8.2: a no-show is a cancellation at the start).
  const noShow =
    viewer === 'GUEST' && afterStart(booking, now)
      ? 'Cancelling after the pick-up time counts as not turning up, so the refund is worked out as at the pick-up time. '
      : '';
  const message =
    noShow +
    (outcome.kind === 'WITHDRAW_REQUEST'
      ? 'Your card authorisation will be released. Nothing is charged.'
      : outcome.kind === 'ABANDON_CHECKOUT'
        ? "The dates you're holding will be released. Nothing has been charged."
        : outcome.kind === 'HOST_CANCELLATION'
          ? allBack
            ? `Everything the guest paid has already been refunded, so nothing more goes back.${hostFee}`
            : `The guest gets a full refund of ${formatDollars(outcome.refundCents)}.${earlier}${hostFee}`
          : allBack
            ? 'Everything you paid has already been refunded, so nothing more comes back.'
            : outcome.feeCents === 0
              ? `You'll get a full refund of ${formatDollars(outcome.refundCents)}.${earlier}`
              : outcome.refundCents === 0
                ? `Under ${policy}, this cancellation isn't refundable.${earlier}`
                : `Under ${policy} you'll get ${formatDollars(outcome.refundCents)} back; ${formatDollars(outcome.feeCents)} is kept.${earlier}`);
  return {
    allowed: true,
    kind: outcome.kind,
    refundCents: outcome.refundCents,
    feeCents: outcome.feeCents,
    hostShareCents: viewer === 'GUEST' ? 0 : outcome.hostShareCents,
    hostFeeCents: viewer === 'GUEST' ? 0 : outcome.hostFeeCents,
    refundPct: outcome.refundPct,
    hoursBeforeStart: outcome.hoursBeforeStart,
    message,
  };
}

/**
 * Carries out a cancellation: releases the authorisation or refunds through Stripe first (the
 * idempotency key makes a retry safe), then records everything in one transaction.
 */
async function carryOut(
  booking: BookingDocument,
  outcome: PaidOutcome,
  input: {
    by: string;
    cancelledBy: 'GUEST' | 'HOST' | 'SUPPORT';
    reason:
      | 'GUEST_CANCELLED'
      | 'HOST_CANCELLED'
      | 'REQUEST_WITHDRAWN'
      | 'GUEST_NO_SHOW'
      | 'HOST_NO_SHOW'
      | 'PLATFORM';
    note?: string;
  },
  now: Date,
): Promise<BookingDocument> {
  const payment = await bookingPayment(booking);
  // An unpaid checkout or a request was only authorised: the authorisation is released, not refunded.
  const uncaptured = booking.status === 'PAYMENT_PENDING' || booking.status === 'PENDING';
  // The trip's payout: one being sent this moment is neither cancelled nor paid twice, so the cancellation waits
  // for it; one already paid is settled against the Host's share of the kept fee (plan §8.1, items 15 and 16).
  const tripPayout = uncaptured
    ? null
    : await tripPayoutOnCancel(booking._id, outcome.hostShareCents, {
        reliefCents: outcome.reliefCents,
        now,
      });
  if (tripPayout?.state === 'IN_FLIGHT') throw payoutInFlight();
  let refund: RefundRecord | undefined;
  if (uncaptured) {
    // Stripe may have taken it a moment ago (the Host accepted, 3-D Secure finished): then it isn't ended.
    if ((await releasePayment(payment, now)) !== 'released') throw justChanged(booking.status);
  } else if (outcome.refundCents > 0) {
    // A payment staff already refunded in part can still be refunded, up to what's left.
    if (!payment || !isPaid(payment.status)) {
      throw new HttpError(409, 'NOT_PAID', "This booking's payment isn't complete. Please contact support.");
    }
    // Nothing left to give back (staff refunded the rest meanwhile): it's cancelled all the same.
    if (afterEarlierRefunds(outcome, payment).refundCents > 0) {
      refund = await refundIntent(payment, outcome.refundCents, `refund-${booking.id}-cancellation`);
    }
  }
  // What actually goes back, for the booking's record and what both parties are told.
  const applied: CancellationOutcome = { ...outcome, refundCents: refund?.amountCents ?? 0 };

  const cancelled = await withTransaction(async (session) => {
    // The Host's share of earlier Host-funded refunds as the cancellation leaves it (afterEarlierRefunds), before
    // the trip's payout is cancelled and what was to come off it is owed instead.
    for (const relief of payment && !uncaptured ? outcome.reliefs : []) {
      await PaymentModel.updateOne(
        { _id: payment!._id },
        {
          $set: {
            'refunds.$[earlier].hostCents': relief.hostCents,
            'refunds.$[earlier].hostReliefCents': relief.reliefCents,
          },
        },
        { arrayFilters: [{ 'earlier._id': relief.refundId }], session },
      );
    }
    const ended = await endBooking(
      booking,
      outcome.kind === 'ABANDON_CHECKOUT'
        ? { to: 'EXPIRED', from: ['PAYMENT_PENDING'], by: input.by, reason: 'Checkout abandoned', now }
        : {
            to: 'CANCELLED',
            // ACTIVE: a Guest no-show after the Host's check-in, which the Guest never confirmed (plan §8.2).
            from:
              booking.status === 'PENDING' || booking.status === 'ACTIVE' ? [booking.status] : ['CONFIRMED'],
            by: input.by,
            reason: outcome.disputed
              ? [input.note, 'Nothing was refunded: the card dispute on its payment decides the money.']
                  .filter(Boolean)
                  .join(' ')
              : input.note,
            now,
            cancellation: {
              reason: input.reason,
              refundCents: applied.refundCents,
              feeCents: outcome.feeCents,
              hostShareCents: outcome.hostShareCents,
              hostFeeCents: outcome.hostFeeCents,
              ...(outcome.disputed && { disputed: true }),
            },
          },
      session,
    );
    if (!ended) throw new HttpError(409, 'ALREADY_CHANGED', 'This booking has just changed. Please refresh.');

    if (payment) {
      const fresh = await PaymentModel.findById(payment._id).session(session);
      if (fresh) {
        if (refund) {
          // Recorded from Stripe already if an earlier try's transaction failed (plan §8.1, item 13): replaced.
          const known = fresh.refunds.findIndex((item) => item.stripeRefundId === refund.stripeRefundId);
          if (known >= 0) fresh.refunds.splice(known, 1);
          fresh.refunds.push({
            amountCents: refund.amountCents,
            reason: `Cancellation (${input.reason})`,
            kind: 'CANCELLATION',
            issuedBy: new mongoose.Types.ObjectId(input.by),
            // A policy refund of rental the Host would otherwise get (plan §8.1, item 15).
            fundedBy:
              outcome.kind === 'GUEST_CANCELLATION' || outcome.kind === 'HOST_CANCELLATION'
                ? 'HOST'
                : 'PLATFORM',
            stripeRefundId: refund.stripeRefundId,
            status: refund.status,
            ...(refund.failureReason && { failureReason: refund.failureReason }),
            createdAt: now,
          });
          fresh.status = statusAfterRefunds(fresh);
        } else if (fresh.status === 'PENDING' || fresh.status === 'AUTHORISED') {
          fresh.status = 'CANCELLED';
        }
        await fresh.save({ session });
      }
    }
    if (outcome.hostFeeCents > 0) {
      await UserModel.updateOne(
        { _id: booking.hostId },
        { $inc: { 'hostProfile.feesOwedCents': outcome.hostFeeCents } },
        { session },
      );
    }
    // A dispute already lost (or prevented): the payment went back to the cardholder through it.
    const disputeSettled =
      Boolean(outcome.disputed) && ['lost', 'prevented'].includes(payment?.dispute?.status ?? '');
    if (outcome.kind !== 'ABANDON_CHECKOUT') {
      await notifyCancelled(
        record(ended),
        await loadBookingContext(record(ended)),
        applied,
        input.cancelledBy,
        {
          session,
          released: uncaptured,
          // Refused by Stripe at once: staff are alerted (refundIntent) and return it another way.
          refundFailed: refund?.status === 'FAILED',
          reason: input.reason,
          ...(tripPayout?.state === 'PAID' && {
            tripPayoutSentCents: tripPayout.paidCents,
            hostOwesCents: tripPayout.owedCents,
          }),
          ...(outcome.reliefCents > 0 && { hostRefundReliefCents: outcome.reliefCents }),
          ...(outcome.disputed && { disputed: true }),
          ...(disputeSettled && { disputeSettled: true }),
        },
      );
    }
    if (outcome.disputed) {
      // The dispute decides the money (plan §8.1, item 12): staff refund the Guest once it's won, if they should.
      await alertStaff(
        {
          type: 'CANCELLED_IN_DISPUTE',
          title: `${booking.ref} was cancelled during a card dispute`,
          body: `booking ${booking.ref} was cancelled while its payment is in a card dispute (${payment?.dispute?.status ?? 'open'}), so nothing was refunded and the Host gets no payout for it. ${
            disputeSettled
              ? 'The payment already went back to the guest’s card through the dispute.'
              : 'If the dispute is won, refund the guest what this cancellation would have given back, through Refunds on the booking.'
          }`,
          link: `/admin/bookings/${booking.ref}`,
          dedupeKey: `CANCELLED_IN_DISPUTE:${booking.id}`,
        },
        { session },
      );
    }
    return ended;
  });
  // A second payment still live at Stripe goes too.
  if (uncaptured) await releaseOtherPayments(booking, payment, now);

  await recordAudit({
    actorId: input.by,
    action: `booking.${outcome.kind.toLowerCase().replace(/_/g, '-')}`,
    entity: 'booking',
    entityId: booking.id,
    before: { status: booking.status },
    after: {
      refundCents: applied.refundCents,
      feeCents: outcome.feeCents,
      hostFeeCents: outcome.hostFeeCents,
      ...(uncaptured && { authorisationReleased: true }),
      // What the Host no longer pays towards earlier Host-funded refunds (plan §8.1, item 15).
      ...(outcome.reliefCents > 0 && {
        hostShareCents: outcome.hostShareCents,
        hostRefundReliefCents: outcome.reliefCents,
      }),
      // Staff give a reason and a note (plan §8.2).
      ...(input.cancelledBy === 'SUPPORT' && { reason: input.reason, note: input.note }),
      // Nothing refunded or kept: the card dispute decides the money (plan §8.1, item 12).
      ...(outcome.disputed && { disputed: true }),
    },
  });
  if (outcome.kind === 'HOST_CANCELLATION') await flagRepeatedHostCancellations(booking.hostId, now);
  if (outcome.kind === 'WITHDRAW_REQUEST') await updateResponseRate(booking.hostId);
  forget('vehicles:featured');
  return cancelled;
}

/**
 * POST /bookings/{id}/cancel by the Guest or the Host (plan §8.2). `expectedRefundCents`: the refund the
 * preview showed. When the refund worked out now is less (the full-refund cut-off passed while the dialog was
 * open, say), nothing is cancelled: 409 REFUND_CHANGED with the new figure, to confirm again (plan §11: the
 * refund and fee are shown before the user confirms).
 */
export async function cancelBooking(
  booking: BookingDocument,
  viewer: Viewer,
  actorId: string,
  { note, expectedRefundCents }: { note?: string; expectedRefundCents?: number } = {},
  now = new Date(),
) {
  if (viewer === 'HOST' && booking.status === 'PENDING') {
    throw new HttpError(409, 'USE_DECLINE', 'Decline the request instead: declining carries no fee.');
  }
  if (viewer === 'HOST' && afterStart(booking, now)) throw hostTripStarted();
  if (await inChargeback(booking)) throw paymentDisputed();
  const outcome = await outcomeFor(booking, viewer, now);
  if (!outcome)
    throw new HttpError(
      409,
      'NOT_CANCELLABLE',
      "This booking can't be cancelled here. Please contact support.",
    );
  if (expectedRefundCents !== undefined && outcome.refundCents < expectedRefundCents) {
    const fresh = await cancellationPreview(booking, viewer, now);
    throw new HttpError(
      409,
      'REFUND_CHANGED',
      `The refund has changed since you opened this: it's now ${formatDollars(outcome.refundCents)}, not ${formatDollars(expectedRefundCents)}. Check it, then confirm again.`,
      { expectedRefundCents: fresh.message },
    );
  }
  const reason =
    outcome.kind === 'WITHDRAW_REQUEST'
      ? 'REQUEST_WITHDRAWN'
      : outcome.kind === 'HOST_CANCELLATION'
        ? 'HOST_CANCELLED'
        : 'GUEST_CANCELLED';
  return carryOut(
    booking,
    outcome,
    { by: actorId, cancelledBy: viewer === 'HOST' ? 'HOST' : 'GUEST', reason, note },
    now,
  );
}

/**
 * What a staff cancellation does (plan §8.2). A confirmed booking: a Guest no-show is a Guest cancellation at
 * the start time (whenever support records it, which is usually after the start), a Host no-show or a Host
 * cancellation made for the Host is a Host cancellation, and a platform cancellation a full refund. A request,
 * or a booking waiting for the Guest's verification, was only authorised: it's a platform cancellation that
 * releases the authorisation, with no fee for anyone. A trip under way can be cancelled only as a Guest no-show,
 * when the Host recorded the check-in alone and the Guest never confirmed it. Earlier refunds come off the
 * refund (afterEarlierRefunds).
 */
async function adminOutcome(
  booking: BookingDocument,
  reason: AdminCancelReason,
  now: Date,
): Promise<PaidOutcome> {
  if (booking.status === 'PENDING') {
    if (reason !== 'PLATFORM') {
      throw new HttpError(
        409,
        'NOT_CONFIRMED',
        'A no-show or a Host cancellation applies only to a confirmed booking. Cancel this request as a platform cancellation.',
      );
    }
    return afterEarlierRefunds({ ...platformCancellation(booking, now), refundCents: 0 }, null);
  }
  if (booking.status === 'ACTIVE') {
    if (reason !== 'GUEST_NO_SHOW' || !(await guestMayNotHaveShown(booking))) {
      throw new HttpError(
        409,
        'NOT_CANCELLABLE',
        'A trip under way can be cancelled only as a Guest no-show, when the Host did the check-in alone and the Guest hasn’t confirmed it.',
      );
    }
  } else if (booking.status !== 'CONFIRMED') {
    throw new HttpError(
      409,
      'NOT_CANCELLABLE',
      'Only a confirmed booking or a request waiting for an answer can be cancelled here.',
    );
  }
  const settings = await getPlatformSettings();
  const outcome =
    reason === 'GUEST_NO_SHOW'
      ? guestCancellation(booking, settings, booking.startAt)
      : reason === 'HOST_NO_SHOW' || reason === 'HOST_CANCELLED'
        ? hostCancellation(booking, settings, now)
        : platformCancellation(booking, now);
  const payment = await bookingPayment(booking);
  // A chargeback (plan §8.1, item 12): Stripe refuses a refund, and the dispute decides the money, so nothing is
  // refunded or kept here. The Host is settled as for a full refund (no share of a kept fee, nothing towards
  // earlier refunds they funded): they aren't paid from money going back to the cardholder.
  const paid = isChargedBack(payment)
    ? {
        ...afterEarlierRefunds(
          { ...outcome, refundCents: payment!.amountCents, feeCents: 0, hostShareCents: 0 },
          payment,
        ),
        refundCents: 0,
        feeCents: 0,
        disputed: true,
      }
    : afterEarlierRefunds(outcome, payment);
  // The trip's payout is being sent this moment (a trip under way): the cancellation waits for it.
  const trip = await tripPayoutOnCancel(booking._id, paid.hostShareCents, {
    reliefCents: paid.reliefCents,
    now,
  });
  if (trip.state === 'IN_FLIGHT') {
    throw payoutInFlight();
  }
  return paid;
}

/**
 * A trip the Host checked in alone, which the Guest hasn't confirmed and which has no check-out: the Guest may
 * never have turned up (plan §8.2, no-shows). The trip started with the Host's check-in, so staff can still
 * cancel it as a Guest no-show, and the start check reminds the Guest and alerts staff.
 */
export async function guestMayNotHaveShown(booking: Pick<BookingRecord, '_id' | 'hostId'>): Promise<boolean> {
  const reports = await ConditionReportModel.find({ bookingId: booking._id })
    .select('stage submittedBy confirmedByGuestAt')
    .lean();
  const checkIn = reports.find((report) => report.stage === 'CHECK_IN');
  return Boolean(
    checkIn &&
    !reports.some((report) => report.stage === 'CHECK_OUT') &&
    checkIn.submittedBy?.equals(booking.hostId) &&
    !checkIn.confirmedByGuestAt,
  );
}

/** Staff cancel a confirmed booking or a pending one (plan §8.2), with the normal path's side effects. */
export async function adminCancelBooking(
  booking: BookingDocument,
  staffId: string,
  reason: AdminCancelReason,
  note: string,
  now = new Date(),
) {
  const outcome = await adminOutcome(booking, reason, now);
  return carryOut(booking, outcome, { by: staffId, cancelledBy: 'SUPPORT', reason, note }, now);
}

/**
 * GET /admin/bookings/{id}/cancellation-preview (plan §8.2: "refund preview and choice"): what cancelling
 * for this reason would refund and cost, from the same policy engine as the cancellation itself.
 */
export async function adminCancellationPreview(
  booking: BookingDocument,
  reason: AdminCancelReason,
  now = new Date(),
): Promise<AdminCancellationPreview> {
  const none = { refundCents: 0, feeCents: 0, hostShareCents: 0, hostFeeCents: 0, releasedCents: 0 };
  let outcome: PaidOutcome;
  try {
    outcome = await adminOutcome(booking, reason, now);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return {
      reason,
      allowed: false,
      kind: null,
      ...none,
      refundPct: 0,
      hoursBeforeStart: 0,
      message: error.message,
    };
  }
  const base = {
    reason,
    kind: outcome.kind as AdminCancellationPreview['kind'],
    refundPct: outcome.refundPct,
    hoursBeforeStart: outcome.hoursBeforeStart,
  };
  const payment = await bookingPayment(booking);

  if (booking.status === 'PENDING') {
    const releasedCents = payment?.amountCents ?? booking.price.totalCents;
    return {
      ...base,
      allowed: true,
      ...none,
      releasedCents,
      message: `Nothing has been charged yet: the ${formatDollars(releasedCents)} held on the Guest’s card is released, and nobody pays a fee.`,
    };
  }
  if (outcome.refundCents > 0 && (!payment || !isPaid(payment.status))) {
    return {
      ...base,
      allowed: false,
      ...none,
      message: "This booking's payment isn't complete, so there's nothing to refund yet.",
    };
  }
  // Earlier refunds came off what can still go back to the card (afterEarlierRefunds).
  const refundCents = outcome.refundCents;
  const policy = booking.cancellationTerms
    ? `the ${booking.cancellationTerms.name} policy`
    : 'the cancellation policy';
  const capped =
    refundCents < outcome.policyRefundCents
      ? ` That's ${formatDollars(outcome.policyRefundCents)} under the policy, less what was already refunded.`
      : '';
  // Earlier Host-funded refunds the Guest gets back under this cancellation anyway cost the Host less.
  const relief =
    outcome.reliefCents > 0
      ? ` The Host pays ${formatDollars(outcome.reliefCents)} less towards the earlier Host-funded refunds, as this cancellation gives the Guest that back anyway.`
      : '';
  // The Host's share of the kept fee is the policy's, so after an earlier refund it can be more than is kept.
  const hostShare =
    outcome.hostShareCents <= outcome.feeCents
      ? `, of which the Host gets ${formatDollars(outcome.hostShareCents)}`
      : `, and the Host gets ${formatDollars(outcome.hostShareCents)}`;
  // The trip's payout already went (a no-show after the Host's check-in): settled against their share.
  const trip = await tripPayoutOnCancel(booking._id, outcome.hostShareCents, {
    reliefCents: outcome.reliefCents,
    now,
  });
  const sent =
    trip.state !== 'PAID'
      ? ''
      : trip.owedCents > 0
        ? ` The Host’s trip payout of ${formatDollars(trip.paidCents)} was already sent, so ${formatDollars(trip.owedCents)} of it comes off their next payout.`
        : trip.topUpCents > 0
          ? ` The Host’s trip payout of ${formatDollars(trip.paidCents)} was already sent, so they’re paid the ${formatDollars(trip.topUpCents)} difference.`
          : ` The Host’s trip payout of ${formatDollars(trip.paidCents)} was already sent, which is their share.`;
  if (outcome.disputed) {
    // The dispute decides the money (plan §8.1, item 12): nothing goes back through Stripe here.
    const settled = ['lost', 'prevented'].includes(payment?.dispute?.status ?? '');
    return {
      ...base,
      allowed: true,
      ...none,
      hostFeeCents: outcome.hostFeeCents,
      message: `The Guest’s payment is in a card dispute, so nothing is refunded here: the dispute decides the money${settled ? ', and it has already gone back to their card' : ''}. The Host gets no payout or share of a fee for this booking.${outcome.hostFeeCents > 0 ? ` A Host cancellation fee of ${formatDollars(outcome.hostFeeCents)} comes off the Host’s next payout.` : ''}${sent}${settled ? '' : ' If the dispute is won, refund the Guest through Refunds on the booking.'}`,
    };
  }
  const message =
    outcome.kind === 'GUEST_CANCELLATION'
      ? `A Guest cancellation at the start time, under ${policy}: the Guest gets ${formatDollars(refundCents)} back${outcome.feeCents > 0 || outcome.hostShareCents > 0 ? ` and ${formatDollars(outcome.feeCents)} is kept${outcome.hostShareCents > 0 ? hostShare : ''}` : ''}.${capped}${relief}${sent}`
      : outcome.kind === 'HOST_CANCELLATION'
        ? `A Host cancellation: the Guest gets ${formatDollars(refundCents)} back, a full refund.${capped} ${outcome.hostFeeCents > 0 ? `A Host cancellation fee of ${formatDollars(outcome.hostFeeCents)} comes off the Host’s next payout.` : 'The Host cancellation fee in the settings is $0.'}${relief}${sent}`
        : `The Guest gets ${formatDollars(refundCents)} back, a full refund, and the Host pays no fee.${capped}${relief}${sent}`;
  return {
    ...base,
    allowed: true,
    refundCents,
    feeCents: outcome.feeCents,
    hostShareCents: outcome.hostShareCents,
    hostFeeCents: outcome.hostFeeCents,
    releasedCents: 0,
    message,
  };
}

/** Repeated Host cancellations raise a risk flag for admins (plan §8.1, item 10). */
async function flagRepeatedHostCancellations(hostId: Types.ObjectId, now: Date) {
  const settings = await getPlatformSettings();
  const since = new Date(now.getTime() - 90 * 24 * 60 * MINUTE_MS);
  const count = await BookingModel.countDocuments({
    hostId,
    cancellationReason: mongoose.trusted({ $in: ['HOST_CANCELLED', 'HOST_NO_SHOW'] }),
    cancelledAt: mongoose.trusted({ $gte: since }),
  });
  if (count < settings.risk.hostCancellationsPer90Days) return;
  await UserModel.updateOne(
    {
      _id: hostId,
      riskFlags: mongoose.trusted({
        $not: { $elemMatch: { code: 'HOST_CANCELLATIONS', clearedAt: { $exists: false } } },
      }),
    },
    {
      $push: {
        riskFlags: {
          code: 'HOST_CANCELLATIONS',
          detail: `${count} Host cancellations in 90 days`,
          createdAt: now,
        },
      },
    },
  );
}

/**
 * `booking.expirePaymentHold` (plan §4.3): the 30 minutes are up. A payment that went through in the
 * meantime (a late webhook) confirms the booking instead; otherwise the dates are released.
 */
export async function expirePaymentHold(
  bookingId: string,
  now = new Date(),
): Promise<'expired' | 'paid' | 'waiting' | 'skipped'> {
  const booking = await BookingModel.findById(bookingId);
  if (!booking || booking.status !== 'PAYMENT_PENDING') return 'skipped';
  if (booking.holdExpiresAt && booking.holdExpiresAt > now) return 'skipped';

  const payment = await bookingPayment(booking);
  if (payment) {
    const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
    if (intent.status === 'succeeded' || intent.status === 'requires_capture') {
      await withTransaction((session) => applyPaymentIntent(intent, session, now));
      return 'paid';
    }
    // The bank is still deciding: keep the dates held until the next check, unless someone else booked
    // them since the hold ran out (then the payment is refunded if it goes through).
    const keepWaiting = () =>
      withTransaction(async (session) => {
        if (await tripDatesStillHeld(booking, session, now)) {
          await extendTripHold(booking._id, new Date(now.getTime() + PROCESSING_HOLD_MS), session);
        }
      });
    if (intent.status === 'processing') {
      await keepWaiting();
      return 'waiting';
    }
    // 3-D Secure may finish between the check above and the release: then it's applied, not expired.
    const released = await releasePayment(payment, now);
    if (released === 'paid') return 'paid';
    if (released === 'processing') {
      await keepWaiting();
      return 'waiting';
    }
  }
  await withTransaction(async (session) => {
    const ended = await endBooking(
      booking,
      { to: 'EXPIRED', from: ['PAYMENT_PENDING'], reason: 'Payment not completed in time', now },
      session,
    );
    if (ended && payment) await markReleased(payment, session);
  });
  await releaseOtherPayments(booking, payment, now);
  return 'expired';
}

const EXPIRY_REASONS = {
  EXPIRED: 'The host did not answer in time',
  VERIFICATION_EXPIRED: "The guest's verification was not approved in time",
  VERIFICATION_REJECTED: "The guest's verification was rejected",
} as const;

/**
 * `booking.expireRequest`: 24 h without an answer from the Host, or without the Guest's verification
 * being approved; the authorisation is released (plan §8.1, item 5; §8.2). `rejected` ends it at once
 * because support rejected the verification.
 */
export async function expireRequest(
  bookingId: string,
  now = new Date(),
  { force = false, rejected = false } = {},
): Promise<boolean> {
  const booking = await BookingModel.findById(bookingId);
  if (!booking || booking.status !== 'PENDING') return false;
  if (!force && booking.requestExpiresAt && booking.requestExpiresAt > now) return false;
  // Whose answer was missing: support's, when the Host had nothing left to do; otherwise the Host's.
  const outcome = rejected
    ? 'VERIFICATION_REJECTED'
    : booking.instantBook || (awaitsVerification(booking) && !hostAnswers(booking))
      ? 'VERIFICATION_EXPIRED'
      : 'EXPIRED';
  const payment = await bookingPayment(booking);
  // A capture that went through a moment ago (the Host accepted, or support approved the check, as the 24 h
  // ran out; a capture that timed out) confirms the booking instead: it's never ended with the money taken.
  const released = await releasePayment(payment, now);
  if (released === 'paid') return false;
  if (released === 'processing') {
    throw new HttpError(
      409,
      'PAYMENT_PROCESSING',
      "The guest's payment is still being processed. Please try again in a few minutes.",
    );
  }
  const ended = await withTransaction(async (session) => {
    const done = await endBooking(
      booking,
      { to: 'EXPIRED', from: ['PENDING'], reason: EXPIRY_REASONS[outcome], now },
      session,
    );
    if (!done) return null;
    if (payment) await markReleased(payment, session);
    await notifyRequestEnded(record(done), await loadBookingContext(record(done)), outcome, { session });
    return done;
  });
  if (ended) {
    await releaseOtherPayments(booking, payment, now);
    await updateResponseRate(booking.hostId);
  }
  return Boolean(ended);
}

/**
 * Support has decided a Guest's verification (plan §8.2): their identity check or their licence. Approved:
 * once neither waits for support any more, each booking that waited is confirmed by capturing its
 * authorisation, unless its Host still has to accept the request; while the other part still waits, the
 * bookings keep waiting for it. One the Guest's licence no longer qualifies for (plan §3: it expires before
 * the trip ends, say) keeps waiting too, for the Guest to update it or support to cancel it. Rejected: each is
 * ended and its authorisation released.
 */
export async function resolveVerificationReview(
  guestId: string,
  decision: 'APPROVE' | 'REJECT',
  /** Support's decision; left out when Stripe Identity approved the check itself. */
  staffId: string | undefined,
  now = new Date(),
): Promise<VerificationOutcome> {
  const result = { confirmed: [] as string[], waitingForHost: [] as string[], released: [] as string[] };
  const carSuspended: string[] = [];
  const licenceNotEligible: string[] = [];
  const waiting = await BookingModel.find({
    guestId,
    status: 'PENDING',
    'verificationReview.status': 'PENDING',
  }).sort({ createdAt: 1 });
  const guest =
    decision === 'APPROVE' && waiting.length > 0
      ? await UserModel.findById(guestId)
          .select('status closedAt phoneVerifiedAt dob identityVerification driverLicence')
          .lean()
      : null;
  const settings = guest ? await getPlatformSettings() : null;
  if (guest && settings && verificationInReview(guest, settings)) {
    return { ...result, stillInReview: waiting.map((booking) => booking.ref) };
  }

  for (const booking of waiting) {
    // An approval after the trip's start time (or after the 24 h) comes too late (plan §8.2): the booking
    // ends with its card hold released, rather than being charged for a trip that should have started.
    if (
      decision === 'APPROVE' &&
      (booking.startAt <= now || (booking.requestExpiresAt && booking.requestExpiresAt <= now))
    ) {
      if (await expireRequest(booking.id, now, { force: true })) result.released.push(booking.ref);
      continue;
    }
    if (guest && settings && licenceProblemsForTrip(guest, settings, booking, now).length > 0) {
      licenceNotEligible.push(booking.ref);
      continue;
    }
    const decided = await BookingModel.findOneAndUpdate(
      { _id: booking._id, status: 'PENDING', 'verificationReview.status': 'PENDING' },
      {
        $set: {
          verificationReview: {
            status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            decidedAt: now,
            ...(staffId && { decidedBy: staffId }),
          },
        },
      },
      { new: true },
    );
    if (!decided) continue;
    if (decision === 'REJECT') {
      if (await expireRequest(decided.id, now, { force: true, rejected: true })) {
        result.released.push(decided.ref);
      }
      continue;
    }
    if (!decided.instantBook && !decided.hostAcceptedAt) {
      result.waitingForHost.push(decided.ref);
      continue;
    }
    // A suspended car takes no new bookings (plan §8.2): this one waits for the suspension to be lifted.
    if (!(await vehicleTakesBookings(decided.vehicleId))) {
      carSuspended.push(decided.ref);
      continue;
    }
    // Nor is a suspended Guest charged: it waits for staff, and goes ahead if the suspension is lifted in time.
    if (guestOnHold(guest)) {
      await alertGuestOnHold(decided);
      continue;
    }
    try {
      await capturePending(decided, now);
      result.confirmed.push(decided.ref);
    } catch (error) {
      // The authorisation lapsed (or the trip started), so the booking was ended; one whose capture couldn't be
      // settled waits for Stripe, and staff hear of it. The others still go ahead.
      if (!(error instanceof HttpError)) throw error;
      if (CAPTURE_UNSETTLED.includes(error.code)) await captureUnsettled(decided, error);
      else if (ENDED_UNCAPTURED.includes(error.code)) result.released.push(decided.ref);
      else throw error;
    }
  }
  forget('vehicles:featured');
  return {
    ...result,
    ...(carSuspended.length > 0 && { carSuspended }),
    ...(licenceNotEligible.length > 0 && { licenceNotEligible }),
  };
}
