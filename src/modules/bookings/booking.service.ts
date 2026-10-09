import mongoose, { type Types } from 'mongoose';
import { withTransaction } from '../../db.js';
import { stripe } from '../../integrations/stripe.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { randomRef } from '../../lib/refs.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { reserveTripDates } from '../availability/availability.service.js';
import { PaymentModel } from '../payments/payment.model.js';
import { checkBookingVelocity } from '../risk/risk-signals.js';
import { eligibilityProblems, verificationInReview } from '../users/driver-licence.service.js';
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
  statusAfterRefunds,
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
  const problems = eligibilityProblems(guest, settings, trip.endAt, now);
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

/** GET /bookings: a Guest's trips or a Host's bookings, grouped as in plan §8.2 (dashboard grouping). */
export async function listBookings(userId: string, role: 'guest' | 'host', group?: string, now = new Date()) {
  const owner = role === 'guest' ? { guestId: userId } : { hostId: userId };
  const grouped =
    group && GROUP_FILTERS[group]
      ? GROUP_FILTERS[group]!(now)
      : { status: mongoose.trusted({ $ne: 'PAYMENT_PENDING' }) };
  const filter = { ...owner, $and: role === 'host' ? [grouped, REACHED_THE_HOST] : [grouped] };
  const ascending = group === 'upcoming' || group === 'requests';
  const bookings = await BookingModel.find(filter)
    .sort({ startAt: ascending ? 1 : -1 })
    .limit(100)
    .lean();
  const others = await UserModel.find({
    _id: mongoose.trusted({
      $in: bookings.map((booking) => (role === 'guest' ? booking.hostId : booking.guestId)),
    }),
  })
    .select('firstName avatarUrl')
    .lean();
  const vehicles = await VehicleModel.find({
    _id: mongoose.trusted({ $in: bookings.map((booking) => booking.vehicleId) }),
  })
    .select('slug')
    .lean();

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
      },
      amountCents: role === 'guest' ? booking.price.totalCents : booking.price.hostPayoutCents,
      ...(booking.status === 'PENDING' &&
        booking.requestExpiresAt && { requestExpiresAt: booking.requestExpiresAt.toISOString() }),
      ...(booking.verificationReview && { verificationReview: booking.verificationReview.status }),
      ...(booking.status === 'PENDING' && booking.hostAcceptedAt && { hostAccepted: true }),
    };
  });
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

/**
 * POST /bookings/{id}/accept: the Host accepts a request; the authorisation is captured (plan §8.1).
 * While the Guest's verification is still in review, the acceptance is recorded and the booking is
 * confirmed when support approves the check (plan §8.2).
 */
export async function acceptBooking(
  booking: BookingDocument,
  hostId: string,
  now = new Date(),
): Promise<BookingDocument> {
  if (booking.status !== 'PENDING')
    throw new HttpError(409, 'NOT_PENDING', 'This request has already been answered.');
  if (booking.instantBook) throw notARequest();
  if (booking.hostAcceptedAt) return booking;
  if (!booking.requestExpiresAt || booking.requestExpiresAt <= now) {
    throw new HttpError(409, 'REQUEST_EXPIRED', 'This request has expired.');
  }

  if (booking.verificationReview?.status === 'PENDING') {
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

/**
 * Captures a pending booking's authorisation, which confirms it. An authorisation that can no longer
 * be captured ends the booking instead.
 */
async function capturePending(booking: BookingDocument, now: Date): Promise<void> {
  const payment = await PaymentModel.findOne({
    bookingId: booking._id,
    type: 'BOOKING',
    status: 'AUTHORISED',
  }).sort({ createdAt: -1 });
  if (!payment)
    throw new HttpError(
      409,
      'NOT_AUTHORISED',
      "The guest's payment isn't authorised. Please contact support.",
    );

  let intent;
  try {
    intent = await captureIntent(payment);
  } catch (error) {
    // The authorisation can no longer be captured: the request can't go ahead.
    await expireRequest(booking.id, now, { force: true });
    throw new HttpError(
      409,
      'PAYMENT_EXPIRED',
      "The guest's card authorisation has lapsed, so this request has expired.",
      {
        reason: error instanceof Error ? error.message : 'capture failed',
      },
    );
  }
  await withTransaction((session) => applyPaymentIntent(intent, session, now));
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
  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });
  await cancelIntent(payment);
  const declined = await withTransaction(async (session) => {
    const ended = await endBooking(
      booking,
      { to: 'DECLINED', from: ['PENDING'], by: hostId, reason },
      session,
    );
    if (!ended) return null;
    if (payment)
      await PaymentModel.updateOne({ _id: payment._id }, { $set: { status: 'CANCELLED' } }, { session });
    await notifyRequestEnded(record(ended), await loadBookingContext(record(ended)), 'DECLINED', { session });
    return ended;
  });
  await updateResponseRate(booking.hostId);
  return declined ?? (await BookingModel.findById(booking._id))!;
}

/** What a cancellation would do, for the actor's role (plan §11: cancellation-preview). */
async function outcomeFor(
  booking: BookingDocument,
  viewer: Viewer,
  now: Date,
): Promise<CancellationOutcome | null> {
  const settings = await getPlatformSettings();
  if (viewer === 'GUEST') {
    if (booking.status === 'PAYMENT_PENDING') return noCharge('ABANDON_CHECKOUT', booking, now);
    if (booking.status === 'PENDING') return noCharge('WITHDRAW_REQUEST', booking, now);
    if (booking.status === 'CONFIRMED') return guestCancellation(booking, settings, now);
  }
  if (viewer === 'HOST' && booking.status === 'CONFIRMED') return hostCancellation(booking, settings, now);
  return null;
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
  if (!outcome || outcome.kind === 'PLATFORM_CANCELLATION') {
    return {
      allowed: false,
      kind: null,
      refundCents: 0,
      feeCents: 0,
      hostShareCents: 0,
      hostFeeCents: 0,
      refundPct: 0,
      hoursBeforeStart: 0,
      message:
        viewer === 'HOST' && booking.status === 'PENDING'
          ? 'Decline the request instead: declining carries no fee.'
          : "This booking can't be cancelled here. Please contact support.",
    };
  }
  const policy = booking.cancellationTerms
    ? `the ${booking.cancellationTerms.name} policy`
    : 'the cancellation policy';
  const message =
    outcome.kind === 'WITHDRAW_REQUEST'
      ? 'Your card authorisation will be released. Nothing is charged.'
      : outcome.kind === 'ABANDON_CHECKOUT'
        ? "The dates you're holding will be released. Nothing has been charged."
        : outcome.kind === 'HOST_CANCELLATION'
          ? `The guest gets a full refund of ${formatDollars(outcome.refundCents)}.${outcome.hostFeeCents > 0 ? ` A Host cancellation fee of ${formatDollars(outcome.hostFeeCents)} comes off your next payout.` : ''}`
          : outcome.feeCents === 0
            ? `You'll get a full refund of ${formatDollars(outcome.refundCents)}.`
            : outcome.refundCents === 0
              ? `Under ${policy}, this cancellation isn't refundable.`
              : `Under ${policy} you'll get ${formatDollars(outcome.refundCents)} back; ${formatDollars(outcome.feeCents)} is kept.`;
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
  outcome: CancellationOutcome,
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
  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });
  // An unpaid checkout or a request was only authorised: the authorisation is released, not refunded.
  const uncaptured = booking.status === 'PAYMENT_PENDING' || booking.status === 'PENDING';
  let refund: RefundRecord | undefined;
  if (uncaptured) {
    await cancelIntent(payment);
  } else if (outcome.refundCents > 0) {
    // A payment staff already refunded in part can still be refunded, up to what's left.
    if (!payment || !isPaid(payment.status)) {
      throw new HttpError(409, 'NOT_PAID', "This booking's payment isn't complete. Please contact support.");
    }
    refund = await refundIntent(payment, outcome.refundCents, `refund-${booking.id}-cancellation`);
  }

  const cancelled = await withTransaction(async (session) => {
    const ended = await endBooking(
      booking,
      outcome.kind === 'ABANDON_CHECKOUT'
        ? { to: 'EXPIRED', from: ['PAYMENT_PENDING'], by: input.by, reason: 'Checkout abandoned', now }
        : {
            to: 'CANCELLED',
            from: booking.status === 'PENDING' ? ['PENDING'] : ['CONFIRMED'],
            by: input.by,
            reason: input.note,
            now,
            cancellation: {
              reason: input.reason,
              refundCents: refund?.amountCents ?? outcome.refundCents,
              feeCents: outcome.feeCents,
              hostShareCents: outcome.hostShareCents,
              hostFeeCents: outcome.hostFeeCents,
            },
          },
      session,
    );
    if (!ended) throw new HttpError(409, 'ALREADY_CHANGED', 'This booking has just changed. Please refresh.');

    if (payment) {
      const fresh = await PaymentModel.findById(payment._id).session(session);
      if (fresh) {
        if (refund) {
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
    if (outcome.kind !== 'ABANDON_CHECKOUT') {
      await notifyCancelled(
        record(ended),
        await loadBookingContext(record(ended)),
        outcome,
        input.cancelledBy,
        { session, released: uncaptured },
      );
    }
    return ended;
  });

  await recordAudit({
    actorId: input.by,
    action: `booking.${outcome.kind.toLowerCase().replace(/_/g, '-')}`,
    entity: 'booking',
    entityId: booking.id,
    before: { status: booking.status },
    after: {
      refundCents: refund?.amountCents ?? outcome.refundCents,
      feeCents: outcome.feeCents,
      hostFeeCents: outcome.hostFeeCents,
      ...(uncaptured && { authorisationReleased: true }),
      // Staff give a reason and a note (plan §8.2).
      ...(input.cancelledBy === 'SUPPORT' && { reason: input.reason, note: input.note }),
    },
  });
  if (outcome.kind === 'HOST_CANCELLATION') await flagRepeatedHostCancellations(booking.hostId, now);
  if (outcome.kind === 'WITHDRAW_REQUEST') await updateResponseRate(booking.hostId);
  forget('vehicles:featured');
  return cancelled;
}

/** POST /bookings/{id}/cancel by the Guest or the Host (plan §8.2). */
export async function cancelBooking(
  booking: BookingDocument,
  viewer: Viewer,
  actorId: string,
  note?: string,
  now = new Date(),
) {
  if (viewer === 'HOST' && booking.status === 'PENDING') {
    throw new HttpError(409, 'USE_DECLINE', 'Decline the request instead: declining carries no fee.');
  }
  const outcome = await outcomeFor(booking, viewer, now);
  if (!outcome)
    throw new HttpError(
      409,
      'NOT_CANCELLABLE',
      "This booking can't be cancelled here. Please contact support.",
    );
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
 * the start time, a Host no-show a Host cancellation, and a platform cancellation a full refund. A request,
 * or a booking waiting for the Guest's verification, was only authorised: it's a platform cancellation that
 * releases the authorisation, with no fee for anyone.
 */
async function adminOutcome(
  booking: BookingDocument,
  reason: AdminCancelReason,
  now: Date,
): Promise<CancellationOutcome> {
  if (booking.status === 'PENDING') {
    if (reason !== 'PLATFORM') {
      throw new HttpError(
        409,
        'NOT_CONFIRMED',
        'A no-show applies only to a confirmed booking. Cancel this request as a platform cancellation.',
      );
    }
    return { ...platformCancellation(booking, now), refundCents: 0 };
  }
  if (booking.status !== 'CONFIRMED') {
    throw new HttpError(
      409,
      'NOT_CANCELLABLE',
      'Only a confirmed booking or a request waiting for an answer can be cancelled here.',
    );
  }
  const settings = await getPlatformSettings();
  return reason === 'GUEST_NO_SHOW'
    ? guestCancellation(booking, settings, now > booking.startAt ? now : booking.startAt)
    : reason === 'HOST_NO_SHOW'
      ? hostCancellation(booking, settings, now)
      : platformCancellation(booking, now);
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
  let outcome: CancellationOutcome;
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
  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });

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
  // Earlier refunds come off what can still go back to the card.
  const refunded = (payment?.refunds ?? [])
    .filter((item) => item.status !== 'FAILED')
    .reduce((sum, item) => sum + item.amountCents, 0);
  const refundCents = Math.min(outcome.refundCents, Math.max(0, (payment?.amountCents ?? 0) - refunded));
  const policy = booking.cancellationTerms
    ? `the ${booking.cancellationTerms.name} policy`
    : 'the cancellation policy';
  const capped =
    refundCents < outcome.refundCents
      ? ` That's ${formatDollars(outcome.refundCents)} under the policy, less what was already refunded.`
      : '';
  const message =
    outcome.kind === 'GUEST_CANCELLATION'
      ? `A Guest cancellation at the start time, under ${policy}: the Guest gets ${formatDollars(refundCents)} back${outcome.feeCents > 0 ? ` and ${formatDollars(outcome.feeCents)} is kept, of which the Host gets ${formatDollars(outcome.hostShareCents)}` : ''}.${capped}`
      : outcome.kind === 'HOST_CANCELLATION'
        ? `A Host cancellation: the Guest gets ${formatDollars(refundCents)} back, a full refund.${capped} ${outcome.hostFeeCents > 0 ? `A Host cancellation fee of ${formatDollars(outcome.hostFeeCents)} comes off the Host’s next payout.` : 'The Host cancellation fee in the settings is $0.'}`
        : `The Guest gets ${formatDollars(refundCents)} back, a full refund, and the Host pays no fee.${capped}`;
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

  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });
  if (payment) {
    const intent = await stripe().paymentIntents.retrieve(payment.stripePaymentIntentId);
    if (intent.status === 'succeeded' || intent.status === 'requires_capture') {
      await withTransaction((session) => applyPaymentIntent(intent, session, now));
      return 'paid';
    }
    if (intent.status === 'processing') return 'waiting';
    await cancelIntent(payment);
  }
  await withTransaction(async (session) => {
    const ended = await endBooking(
      booking,
      { to: 'EXPIRED', from: ['PAYMENT_PENDING'], reason: 'Payment not completed in time', now },
      session,
    );
    if (ended && payment)
      await PaymentModel.updateOne(
        { _id: payment._id, status: 'PENDING' },
        { $set: { status: 'CANCELLED' } },
        { session },
      );
  });
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
  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });
  await cancelIntent(payment);
  const ended = await withTransaction(async (session) => {
    const done = await endBooking(
      booking,
      { to: 'EXPIRED', from: ['PENDING'], reason: EXPIRY_REASONS[outcome], now },
      session,
    );
    if (!done) return null;
    if (payment)
      await PaymentModel.updateOne({ _id: payment._id }, { $set: { status: 'CANCELLED' } }, { session });
    await notifyRequestEnded(record(done), await loadBookingContext(record(done)), outcome, { session });
    return done;
  });
  if (ended) await updateResponseRate(booking.hostId);
  return Boolean(ended);
}

/**
 * Support has decided a Guest's verification (plan §8.2): their identity check or their licence. Approved:
 * once neither waits for support any more, each booking that waited is confirmed by capturing its
 * authorisation, unless its Host still has to accept the request; while the other part still waits, the
 * bookings keep waiting for it. Rejected: each is ended and its authorisation released.
 */
export async function resolveVerificationReview(
  guestId: string,
  decision: 'APPROVE' | 'REJECT',
  /** Support's decision; left out when Stripe Identity approved the check itself. */
  staffId: string | undefined,
  now = new Date(),
): Promise<VerificationOutcome> {
  const result = { confirmed: [] as string[], waitingForHost: [] as string[], released: [] as string[] };
  const waiting = await BookingModel.find({
    guestId,
    status: 'PENDING',
    'verificationReview.status': 'PENDING',
  }).sort({ createdAt: 1 });
  if (decision === 'APPROVE' && waiting.length > 0) {
    const guest = await UserModel.findById(guestId).select('identityVerification driverLicence').lean();
    if (guest && verificationInReview(guest, await getPlatformSettings())) {
      return { ...result, stillInReview: waiting.map((booking) => booking.ref) };
    }
  }

  for (const booking of waiting) {
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
    try {
      await capturePending(decided, now);
      result.confirmed.push(decided.ref);
    } catch (error) {
      // The authorisation lapsed, so the booking was ended; the others still go ahead.
      if (!(error instanceof HttpError) || error.code !== 'PAYMENT_EXPIRED') throw error;
      result.released.push(decided.ref);
    }
  }
  forget('vehicles:featured');
  return result;
}
