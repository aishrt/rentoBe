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
import { eligibilityProblems } from '../users/driver-licence.service.js';
import { UserModel, type Role } from '../users/user.model.js';
import { isStaff } from '../users/user.service.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { findLiveVehicle } from '../vehicles/vehicles.service.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import { BookingModel, type BookingDocument } from './booking.model.js';
import { notifyCancelled, notifyRequestEnded } from './booking-notifications.js';
import {
  applyPaymentIntent,
  cancelIntent,
  captureIntent,
  refundIntent,
  statusAfterRefunds,
  type RefundRecord,
} from './booking-payments.js';
import { endBooking } from './booking-transitions.js';
import { loadBookingContext, toBookingView, type BookingRecord, type Viewer } from './booking-view.js';
import type { BookingView, CancellationPreview, CreateBookingInput } from './bookings.schemas.js';
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

  // Verification at checkout (plan §6.1, §8.2): mobile and licence now; the identity check joins on
  // Days 19–20, when a check in review turns an Instant Book into a request.
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
  requests: () => ({ status: 'PENDING' }),
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
    };
  });
}

/** The share of requests a Host answered before they expired, shown to Guests (plan §6.2). */
export async function updateResponseRate(hostId: Types.ObjectId) {
  const [row] = await BookingModel.aggregate<{ total: number; expired: number }>([
    {
      $match: {
        hostId,
        instantBook: false,
        'statusHistory.status': 'PENDING',
        status: { $nin: ['PENDING', 'PAYMENT_PENDING'] },
        cancellationReason: { $ne: 'REQUEST_WITHDRAWN' },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        expired: { $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] } },
      },
    },
  ]);
  if (!row || row.total === 0) return;
  await UserModel.updateOne(
    { _id: hostId },
    { $set: { 'hostProfile.responseRate': Math.round((100 * (row.total - row.expired)) / row.total) } },
  );
}

/** POST /bookings/{id}/accept: the Host accepts a request; the authorisation is captured (plan §8.1). */
export async function acceptBooking(
  booking: BookingDocument,
  hostId: string,
  now = new Date(),
): Promise<BookingDocument> {
  if (booking.status !== 'PENDING')
    throw new HttpError(409, 'NOT_PENDING', 'This request has already been answered.');
  if (!booking.requestExpiresAt || booking.requestExpiresAt <= now) {
    throw new HttpError(409, 'REQUEST_EXPIRED', 'This request has expired.');
  }
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
  await recordAudit({ actorId: hostId, action: 'booking.accepted', entity: 'booking', entityId: booking.id });
  await updateResponseRate(booking.hostId);
  return (await BookingModel.findById(booking._id))!;
}

/** POST /bookings/{id}/decline: the Host declines; the authorisation is released, with no fee (plan §8.2). */
export async function declineBooking(
  booking: BookingDocument,
  hostId: string,
  reason?: string,
): Promise<BookingDocument> {
  if (booking.status !== 'PENDING')
    throw new HttpError(409, 'NOT_PENDING', 'This request has already been answered.');
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
  let refund: RefundRecord | undefined;
  if (outcome.kind === 'ABANDON_CHECKOUT' || outcome.kind === 'WITHDRAW_REQUEST') {
    await cancelIntent(payment);
  } else if (outcome.refundCents > 0) {
    if (!payment || payment.status !== 'SUCCEEDED') {
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
            from: outcome.kind === 'WITHDRAW_REQUEST' ? ['PENDING'] : ['CONFIRMED'],
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
        { session },
      );
    }
    return ended;
  });

  await recordAudit({
    actorId: input.by,
    action: `booking.${outcome.kind.toLowerCase().replace(/_/g, '-')}`,
    entity: 'booking',
    entityId: booking.id,
    after: {
      refundCents: outcome.refundCents,
      feeCents: outcome.feeCents,
      hostFeeCents: outcome.hostFeeCents,
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
 * Staff cancel a confirmed booking (plan §8.2): a Guest no-show is a Guest cancellation at the start
 * time, a Host no-show a Host cancellation, and a platform cancellation a full refund.
 */
export async function adminCancelBooking(
  booking: BookingDocument,
  staffId: string,
  reason: 'GUEST_NO_SHOW' | 'HOST_NO_SHOW' | 'PLATFORM',
  note: string,
  now = new Date(),
) {
  if (booking.status !== 'CONFIRMED')
    throw new HttpError(409, 'NOT_CANCELLABLE', 'Only a confirmed booking can be cancelled here.');
  const settings = await getPlatformSettings();
  const outcome =
    reason === 'GUEST_NO_SHOW'
      ? guestCancellation(booking, settings, now > booking.startAt ? now : booking.startAt)
      : reason === 'HOST_NO_SHOW'
        ? hostCancellation(booking, settings, now)
        : platformCancellation(booking, now);
  return carryOut(booking, outcome, { by: staffId, cancelledBy: 'SUPPORT', reason, note }, now);
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

/** `booking.expireRequest`: 24 h without an answer; the authorisation is released (plan §8.1, item 5). */
export async function expireRequest(
  bookingId: string,
  now = new Date(),
  { force = false } = {},
): Promise<boolean> {
  const booking = await BookingModel.findById(bookingId);
  if (!booking || booking.status !== 'PENDING') return false;
  if (!force && booking.requestExpiresAt && booking.requestExpiresAt > now) return false;
  const payment = await PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({
    createdAt: -1,
  });
  await cancelIntent(payment);
  const ended = await withTransaction(async (session) => {
    const done = await endBooking(
      booking,
      { to: 'EXPIRED', from: ['PENDING'], reason: 'The host did not answer in time', now },
      session,
    );
    if (!done) return null;
    if (payment)
      await PaymentModel.updateOne({ _id: payment._id }, { $set: { status: 'CANCELLED' } }, { session });
    await notifyRequestEnded(record(done), await loadBookingContext(record(done)), 'EXPIRED', { session });
    return done;
  });
  if (ended) await updateResponseRate(booking.hostId);
  return Boolean(ended);
}
