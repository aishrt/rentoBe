import type { Types } from 'mongoose';
import { formatNzAddress } from '../../lib/format.js';
import type { NzAddress } from '../../lib/model-fields.js';
import { nzTripDays } from '../../lib/nz-time.js';
import { payLinkPath } from '../payments/extra-charges.service.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { bookingPayment } from '../payments/booking-payment.js';
import { PaymentModel, type Payment, type Refund } from '../payments/payment.model.js';
import { PayoutModel, type Payout } from '../payouts/payout.model.js';
import { expectedBankDate, gstIn, hostPartOf } from '../payouts/payouts.service.js';
import { ReviewModel } from '../reviews/review.model.js';
import { UserModel, type User } from '../users/user.model.js';
import { VehicleModel, type DeliveryOption, type Vehicle } from '../vehicles/vehicle.model.js';
import { deliveryOptionSummary } from '../vehicles/vehicles.service.js';
import { BookingModel, type Booking, type BookingStatus } from './booking.model.js';
import type { BOOKING_EXTRA_CHARGE_STATUSES, BookingView, EXPIRY_REASONS } from './bookings.schemas.js';

/*
 * A booking as each party sees it (plan §6.2, what each party can see): the exact pickup address,
 * number plate and each other's mobile only once it's confirmed; the Host sees what they earn, the
 * Guest what they pay.
 */

type Id = Types.ObjectId;
export type BookingRecord = Booking & { _id: Id };
export type Viewer = 'GUEST' | 'HOST' | 'STAFF';

const CONFIRMED: BookingStatus[] = ['CONFIRMED', 'ACTIVE', 'COMPLETED'];
export const isConfirmed = (status: BookingStatus) => CONFIRMED.includes(status);

/**
 * Whether a pending booking is the Host's to answer. An Instant Book waiting for the Guest's
 * verification isn't (support decides it), and a request the Host has accepted is already answered.
 */
export const hostAnswers = (booking: Pick<Booking, 'status' | 'instantBook' | 'hostAcceptedAt'>) =>
  booking.status === 'PENDING' && !booking.instantBook && !booking.hostAcceptedAt;

/** Whether a pending booking is waiting for support to review the Guest's verification (plan §8.2). */
export const awaitsVerification = (booking: Pick<Booking, 'status' | 'verificationReview'>) =>
  booking.status === 'PENDING' && booking.verificationReview?.status === 'PENDING';

type PartyUser = Pick<
  User,
  | 'firstName'
  | 'avatarUrl'
  | 'phone'
  | 'phoneVerifiedAt'
  | 'emailVerifiedAt'
  | 'identityVerification'
  | 'hostProfile'
> & {
  _id: Id;
};

export interface BookingContext {
  vehicle:
    | (Pick<Vehicle, 'slug' | 'deliveryOptions' | 'suburb' | 'city' | 'photos' | 'fuelType'> & { _id: Id })
    | null;
  guest: PartyUser | null;
  host: PartyUser | null;
  payment: (Payment & { _id: Id }) | null;
  /** The extra charges' own payments, for their refunds (plan §8.1, item 11). */
  extraChargePayments: Pick<Payment, 'extraChargeId' | 'refunds'>[];
  /** The booking's payouts: its trip's, or a kept fee's, and any extra charges'. */
  payouts: (Payout & { _id: Id })[];
  guestStats: { rating: { avg: number; count: number }; tripCount: number };
  /** The GST rate in settings, for a commission not worked out on a payout yet. */
  gstRatePct: number;
}

const PARTY_FIELDS =
  'firstName avatarUrl phone phoneVerifiedAt emailVerifiedAt identityVerification hostProfile';

/** Everything a booking view needs besides the booking itself. */
export async function loadBookingContext(booking: BookingRecord): Promise<BookingContext> {
  const [vehicle, guest, host, payment, extraChargePayments, reviews, trips, payouts, settings] =
    await Promise.all([
      VehicleModel.findById(booking.vehicleId)
        .select('slug deliveryOptions suburb city photos fuelType')
        .lean(),
      UserModel.findById(booking.guestId).select(PARTY_FIELDS).lean<PartyUser>(),
      UserModel.findById(booking.hostId).select(PARTY_FIELDS).lean<PartyUser>(),
      // The payment that made the booking, not a second one given back (plan §8.1).
      bookingPayment(booking).then((found) => found?.toObject() ?? null),
      PaymentModel.find({ bookingId: booking._id, type: 'EXTRA_CHARGE' })
        .select('extraChargeId refunds')
        .lean(),
      ReviewModel.aggregate<{ avg: number; count: number }>([
        { $match: { subjectId: booking.guestId, direction: 'HOST_TO_GUEST', status: 'PUBLISHED' } },
        { $group: { _id: null, avg: { $avg: '$overall' }, count: { $sum: 1 } } },
      ]),
      BookingModel.countDocuments({ guestId: booking.guestId, status: 'COMPLETED' }),
      PayoutModel.find({ bookingId: booking._id }).lean<(Payout & { _id: Id })[]>(),
      getPlatformSettings(),
    ]);
  return {
    vehicle,
    guest,
    host,
    payment,
    extraChargePayments,
    payouts,
    guestStats: {
      rating: { avg: Math.round((reviews[0]?.avg ?? 0) * 100) / 100, count: reviews[0]?.count ?? 0 },
      tripCount: trips,
    },
    gstRatePct: settings.fees.gstRatePct,
  };
}

function tripPoint(
  booking: BookingRecord,
  optionId: Id | undefined,
  guestAddress: NzAddress | undefined,
  context: BookingContext,
  viewer: Viewer,
) {
  const vehicle = context.vehicle;
  const option: DeliveryOption | undefined = optionId
    ? vehicle?.deliveryOptions.find((candidate) => candidate._id?.equals(optionId))
    : vehicle?.deliveryOptions.find((candidate) => candidate.type === 'PICKUP');
  const fallback: DeliveryOption = {
    type: 'PICKUP',
    label: [vehicle?.suburb, vehicle?.city].filter(Boolean).join(', ') || 'Host location',
    feeCents: 0,
  };
  const chosen = option ?? fallback;
  const summary = deliveryOptionSummary(chosen, vehicle ?? {});
  const confirmed = isConfirmed(booking.status);
  const seesDetails = viewer === 'STAFF' || confirmed;

  let address: string | undefined;
  if (chosen.type === 'DELIVERY' && guestAddress) {
    // The Guest's own address; the Host sees it once they have to deliver there.
    if (viewer !== 'HOST' || confirmed) address = formatNzAddress(guestAddress);
  } else if (chosen.address && (viewer === 'HOST' || seesDetails)) {
    address = formatNzAddress(chosen.address);
  }
  return {
    ...summary,
    ...(address && { address }),
    ...(chosen.instructions && (viewer === 'HOST' || seesDetails) && { instructions: chosen.instructions }),
  };
}

function party(
  user: PartyUser | null,
  stats: { rating: { avg: number; count: number }; tripCount: number },
  showPhone: boolean,
) {
  return {
    // For a link to their public profile (plan §6.2).
    ...(user && { id: user._id.toString() }),
    firstName: user?.firstName ?? 'Former member',
    ...(user?.avatarUrl && { avatarUrl: user.avatarUrl }),
    verified: user?.identityVerification?.status === 'APPROVED',
    rating: stats.rating,
    tripCount: stats.tripCount,
    ...(showPhone && user?.phone && user.phoneVerifiedAt && { phone: user.phone }),
  };
}

/**
 * What the Host earns from the booking, and where its payout stands (plan §8.1, item 19). The commission is
 * the one the trip's payout was made with (as on the payout and its email, plan §8.1, item 22); before there's
 * one, the rental and delivery less the Host's payout. The Guest's service fee isn't the Host's to see.
 */
function payoutView(booking: BookingRecord, context: BookingContext) {
  const main = context.payouts.find(
    (payout) => payout.type !== 'EXTRA_CHARGE' && payout.status !== 'CANCELLED',
  );
  const trip = context.payouts.find((payout) => payout.type === 'TRIP' && payout.status !== 'CANCELLED');
  const commission =
    trip?.commissionCents ??
    booking.price.subtotalCents + booking.price.deliveryCents - booking.price.hostPayoutCents;
  // What actually reached the Host: transfers less any taken back for refunds (plan §8.1, item 15).
  const paid = context.payouts
    .filter((payout) => payout.status === 'PAID')
    .reduce(
      (sum, payout) =>
        sum +
        payout.amountCents -
        (payout.reversals ?? []).reduce((reversed, reversal) => reversed + reversal.amountCents, 0),
      0,
    );
  // The booking's refunds and its extra charges', oldest first (plan §8.1, items 11 and 15).
  const refunds = [
    ...(context.payment?.refunds ?? []).map((refund) => ({ refund, extraCharge: false })),
    ...context.extraChargePayments.flatMap((payment) =>
      payment.refunds.map((refund) => ({ refund, extraCharge: true })),
    ),
  ]
    .filter(({ refund }) => refund.status !== 'FAILED')
    .sort((a, b) => a.refund.createdAt.getTime() - b.refund.createdAt.getTime());
  return {
    hostPayoutCents: booking.price.hostPayoutCents,
    commissionCents: commission,
    commissionGstCents: trip?.commissionGstCents ?? gstIn(commission, context.gstRatePct),
    ...(main && {
      status: main.status,
      ...(main.holdReason && { holdReason: main.holdReason }),
      scheduledFor: main.scheduledFor.toISOString(),
      ...(main.paidAt && {
        paidAt: main.paidAt.toISOString(),
        expectedInBankBy: expectedBankDate(
          main.paidAt,
          context.host?.hostProfile?.payoutDelayDays,
        ).toISOString(),
      }),
    }),
    ...(paid > 0 && { paidCents: paid }),
    ...(refunds.length > 0 && {
      refunds: refunds.map(({ refund, extraCharge }) => ({
        amountCents: refund.amountCents,
        at: refund.createdAt.toISOString(),
        fundedBy: refund.fundedBy,
        // What the Host pays back for it; a cancellation's own refund was settled by the policy instead.
        ...(refund.fundedBy === 'HOST' &&
          refund.kind !== 'CANCELLATION' && { hostCents: hostPartOf(refund) }),
        ...(extraCharge && { extraCharge: true }),
      })),
    }),
  };
}

/**
 * A charge after the trip (plan §8.1, items 6 and 11). One with a payment that isn't paid is one the saved
 * card didn't cover: the Guest was sent the pay link, which their view carries too. A paid one refunded
 * since is REFUNDED once all of it went back, or PAID with refundedCents (plan §8.1, item 15).
 */
function extraChargeView(
  charge: Booking['extraCharges'][number],
  viewer: Viewer,
  payments: BookingContext['extraChargePayments'] = [],
) {
  const refundedCents =
    charge.status === 'SUCCEEDED'
      ? payments
          .filter((payment) => payment.extraChargeId?.equals(charge._id!))
          .flatMap((payment) => payment.refunds ?? [])
          .filter((refund) => refund.status !== 'FAILED')
          .reduce((sum, refund) => sum + refund.amountCents, 0)
      : 0;
  const status: (typeof BOOKING_EXTRA_CHARGE_STATUSES)[number] =
    charge.status === 'SUCCEEDED'
      ? refundedCents >= charge.amountCents
        ? 'REFUNDED'
        : 'PAID'
      : charge.status === 'PENDING'
        ? charge.paymentId
          ? 'UNPAID'
          : 'PENDING'
        : charge.status;
  return {
    id: charge._id!.toString(),
    type: charge.type,
    description: charge.description,
    amountCents: charge.amountCents,
    status,
    ...(refundedCents > 0 && { refundedCents }),
    addedAt: charge._id!.getTimestamp().toISOString(),
    ...(viewer === 'GUEST' &&
      status === 'UNPAID' &&
      charge.paymentId && { payPath: payLinkPath(charge.paymentId.toString()) }),
  };
}

/**
 * The fuel and kilometre terms as booked (plan §3, terms fixed at booking), with the trip's whole allowance
 * worked out the way check-out measures it (plan §5).
 */
function bookedTermsView(booking: BookingRecord, context: BookingContext, days: number) {
  const { fuelPolicy, kmAllowancePerDay, unlimitedKm, extraKmCents } = booking.terms;
  const limited = !unlimitedKm && kmAllowancePerDay !== undefined;
  return {
    fuelPolicy,
    unlimitedKm: !limited,
    ...(limited && { kmAllowancePerDay, allowanceKm: kmAllowancePerDay * days }),
    extraKmCents,
    electric: context.vehicle?.fuelType === 'EV',
  };
}

type ExpiryReason = (typeof EXPIRY_REASONS)[number];

/** The reasons the booking service records when a booking expires (plan §8.2), each with its label. */
const EXPIRY_HISTORY = new Map<string, ExpiryReason>([
  ['Payment not completed in time', 'PAYMENT_TIMEOUT'],
  ['Checkout abandoned', 'CHECKOUT_ABANDONED'],
  ['Replaced by a new checkout', 'CHECKOUT_ABANDONED'],
  ['The host did not answer in time', 'HOST_NO_ANSWER'],
  ["The guest's verification was not approved in time", 'VERIFICATION_EXPIRED'],
  ["The guest's verification was rejected", 'VERIFICATION_REJECTED'],
  ['The dates were booked by someone else while the payment was processing', 'DATES_TAKEN'],
  ['The car was suspended while the payment was processing', 'CAR_UNAVAILABLE'],
]);

const PAID_STATUSES: Payment['status'][] = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** The latest refund of a kind on the booking's payment, e.g. a cancellation's own. */
const latestRefund = (context: BookingContext, kind: NonNullable<Refund['kind']>) =>
  context.payment?.refunds.findLast((refund) => refund.kind === kind);

/**
 * Why an expired booking ended, and whether a payment that went through after it was given back (plan §8.2:
 * each labelled, and the Guest is told what is happening at every step). Read from the reason its status
 * history records; for one without a reason the booking service knows, worked out from the booking.
 */
function expiryView(booking: BookingRecord, context: BookingContext) {
  const recorded = booking.statusHistory.findLast((change) => change.status === 'EXPIRED')?.reason;
  const review = booking.verificationReview?.status;
  const reason: ExpiryReason =
    (recorded && EXPIRY_HISTORY.get(recorded)) ||
    (review === 'REJECTED'
      ? 'VERIFICATION_REJECTED'
      : review || (booking.requestExpiresAt && booking.instantBook)
        ? 'VERIFICATION_EXPIRED'
        : booking.requestExpiresAt
          ? 'HOST_NO_ANSWER'
          : 'PAYMENT_TIMEOUT');
  // Charged after the booking ended, so refunded in full; an authorisation is only released.
  const returned = latestRefund(context, 'LATE_PAYMENT');
  const payment = context.payment;
  const paymentReturned = Boolean(
    booking.paymentReturnedAt && payment && (returned || PAID_STATUSES.includes(payment.status)),
  );
  return {
    reason,
    paymentReturned,
    ...(paymentReturned &&
      payment && {
        refundCents: returned?.amountCents ?? payment.amountCents,
        refundStatus: returned?.status ?? 'PENDING',
      }),
  };
}

export function toBookingView(
  booking: BookingRecord,
  context: BookingContext,
  viewer: Viewer,
  now = new Date(),
): BookingView {
  const confirmed = isConfirmed(booking.status);
  const { price } = booking;
  const mandatoryCents = booking.lineItems
    .filter((item) => item.mandatory)
    .reduce((sum, item) => sum + item.amountCents, 0);
  const holdLive = booking.holdExpiresAt ? booking.holdExpiresAt > now : false;
  const requestLive = booking.requestExpiresAt ? booking.requestExpiresAt > now : false;
  const startedAlready = booking.startAt <= now;
  const cancelledBySelf =
    booking.cancelledBy && booking.cancelledBy.equals(booking.guestId) ? 'GUEST' : undefined;
  const cancellationRefund = booking.cancelledAt ? latestRefund(context, 'CANCELLATION') : undefined;

  return {
    id: booking._id.toString(),
    ref: booking.ref,
    status: booking.status,
    role: viewer,
    instantBook: booking.instantBook,
    vehicle: {
      id: booking.vehicleId.toString(),
      slug: context.vehicle?.slug ?? '',
      title: booking.vehicleSnapshot.title,
      ...(booking.vehicleSnapshot.photoUrl && { photoUrl: booking.vehicleSnapshot.photoUrl }),
      ...(booking.vehicleSnapshot.regoPlate &&
        (viewer !== 'GUEST' || confirmed) && { regoPlate: booking.vehicleSnapshot.regoPlate }),
    },
    start: booking.startAt.toISOString(),
    end: booking.endAt.toISOString(),
    days: nzTripDays(booking.startAt, booking.endAt),
    pickup: tripPoint(booking, booking.pickupOptionId, booking.pickupAddress, context, viewer),
    dropoff: tripPoint(booking, booking.returnOptionId, booking.returnAddress, context, viewer),
    protectionPlan: booking.protectionPlan
      ? {
          code: booking.protectionPlan.code,
          name: booking.protectionPlan.name,
          priceCents: booking.protectionPlan.priceCents,
          excessCents: booking.protectionPlan.excessCents,
          coverSummary: booking.protectionPlan.coverSummary,
          mandatory: booking.protectionPlan.mandatory,
        }
      : null,
    cancellationTier: booking.cancellationTerms
      ? {
          code: booking.cancellationTerms.code,
          name: booking.cancellationTerms.name,
          summary: booking.cancellationTerms.summary,
          refunds: booking.cancellationTerms.refunds.map(({ minHoursBefore, refundPct }) => ({
            minHoursBefore,
            refundPct,
          })),
        }
      : null,
    terms: bookedTermsView(booking, context, nzTripDays(booking.startAt, booking.endAt)),
    lineItems: booking.lineItems.map(({ code, label, amountCents, gstCents, mandatory }) => ({
      code,
      label,
      amountCents,
      gstCents,
      mandatory,
    })),
    price: {
      subtotalCents: price.subtotalCents,
      deliveryCents: price.deliveryCents,
      serviceFeeCents: price.serviceFeeCents,
      protectionCents: price.protectionCents,
      gstCents: price.gstCents,
      totalCents: price.totalCents,
      mandatoryCents,
      optionalCents: price.totalCents - mandatoryCents,
    },
    ...(viewer !== 'GUEST' && { payout: payoutView(booking, context) }),
    ...(booking.status === 'PAYMENT_PENDING' &&
      booking.holdExpiresAt && { holdExpiresAt: booking.holdExpiresAt.toISOString() }),
    ...(booking.status === 'PENDING' &&
      booking.requestExpiresAt && { requestExpiresAt: booking.requestExpiresAt.toISOString() }),
    ...(booking.verificationReview && { verificationReview: booking.verificationReview.status }),
    ...(booking.status === 'PENDING' && booking.hostAcceptedAt && { hostAccepted: true }),
    guest: party(context.guest, context.guestStats, viewer !== 'GUEST' && confirmed),
    host: {
      ...party(
        context.host,
        {
          rating: context.host?.hostProfile?.rating ?? { avg: 0, count: 0 },
          tripCount: context.host?.hostProfile?.tripCount ?? 0,
        },
        viewer !== 'HOST' && confirmed,
      ),
      ...(context.host?.hostProfile?.responseRate !== undefined && {
        responseRate: context.host.hostProfile.responseRate,
      }),
    },
    payment: context.payment
      ? {
          status: context.payment.status,
          ...(context.payment.failureReason && { failureReason: context.payment.failureReason }),
        }
      : null,
    cancellation: booking.cancelledAt
      ? {
          at: booking.cancelledAt.toISOString(),
          by: cancelledBySelf ?? (booking.cancelledBy?.equals(booking.hostId) ? 'HOST' : 'SUPPORT'),
          ...(booking.cancellationReason && { reason: booking.cancellationReason }),
          ...(booking.refundCents !== undefined && { refundCents: booking.refundCents }),
          // Where the refund stands: one Stripe hasn't finished, or that failed, isn't with the Guest yet.
          ...(booking.refundCents !== undefined &&
            booking.refundCents > 0 &&
            cancellationRefund && { refundStatus: cancellationRefund.status }),
          ...(booking.cancellationFeeCents !== undefined && { feeCents: booking.cancellationFeeCents }),
          ...(viewer !== 'GUEST' &&
            booking.hostShareCents !== undefined && { hostShareCents: booking.hostShareCents }),
          ...(viewer !== 'GUEST' &&
            booking.hostCancellationFeeCents !== undefined && {
              hostFeeCents: booking.hostCancellationFeeCents,
            }),
        }
      : null,
    ...(booking.status === 'EXPIRED' && { expiry: expiryView(booking, context) }),
    ...(booking.extraCharges.length > 0 && {
      extraCharges: booking.extraCharges.map((charge) =>
        extraChargeView(charge, viewer, context.extraChargePayments),
      ),
    }),
    actions: {
      pay: viewer === 'GUEST' && booking.status === 'PAYMENT_PENDING' && holdLive,
      cancel: (viewer === 'GUEST' || viewer === 'HOST') && booking.status === 'CONFIRMED',
      withdraw: viewer === 'GUEST' && booking.status === 'PENDING',
      accept: viewer === 'HOST' && hostAnswers(booking) && requestLive && !startedAlready,
      decline: viewer === 'HOST' && hostAnswers(booking),
    },
    createdAt: booking.createdAt.toISOString(),
  };
}
