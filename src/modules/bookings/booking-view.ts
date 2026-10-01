import type { Types } from 'mongoose';
import { formatNzAddress } from '../../lib/format.js';
import type { NzAddress } from '../../lib/model-fields.js';
import { nzTripDays } from '../../lib/nz-time.js';
import { PaymentModel, type Payment } from '../payments/payment.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { UserModel, type User } from '../users/user.model.js';
import { VehicleModel, type DeliveryOption, type Vehicle } from '../vehicles/vehicle.model.js';
import { deliveryOptionSummary } from '../vehicles/vehicles.service.js';
import { BookingModel, type Booking, type BookingStatus } from './booking.model.js';
import type { BookingView } from './bookings.schemas.js';

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
  vehicle: (Pick<Vehicle, 'slug' | 'deliveryOptions' | 'suburb' | 'city' | 'photos'> & { _id: Id }) | null;
  guest: PartyUser | null;
  host: PartyUser | null;
  payment: (Payment & { _id: Id }) | null;
  guestStats: { rating: { avg: number; count: number }; tripCount: number };
}

const PARTY_FIELDS =
  'firstName avatarUrl phone phoneVerifiedAt emailVerifiedAt identityVerification hostProfile';

/** Everything a booking view needs besides the booking itself. */
export async function loadBookingContext(booking: BookingRecord): Promise<BookingContext> {
  const [vehicle, guest, host, payment, reviews, trips] = await Promise.all([
    VehicleModel.findById(booking.vehicleId).select('slug deliveryOptions suburb city photos').lean(),
    UserModel.findById(booking.guestId).select(PARTY_FIELDS).lean<PartyUser>(),
    UserModel.findById(booking.hostId).select(PARTY_FIELDS).lean<PartyUser>(),
    PaymentModel.findOne({ bookingId: booking._id, type: 'BOOKING' }).sort({ createdAt: -1 }).lean(),
    ReviewModel.aggregate<{ avg: number; count: number }>([
      { $match: { subjectId: booking.guestId, direction: 'HOST_TO_GUEST', status: 'PUBLISHED' } },
      { $group: { _id: null, avg: { $avg: '$overall' }, count: { $sum: 1 } } },
    ]),
    BookingModel.countDocuments({ guestId: booking.guestId, status: 'COMPLETED' }),
  ]);
  return {
    vehicle,
    guest,
    host,
    payment,
    guestStats: {
      rating: { avg: Math.round((reviews[0]?.avg ?? 0) * 100) / 100, count: reviews[0]?.count ?? 0 },
      tripCount: trips,
    },
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
    firstName: user?.firstName ?? 'Former member',
    ...(user?.avatarUrl && { avatarUrl: user.avatarUrl }),
    verified: user?.identityVerification?.status === 'APPROVED',
    rating: stats.rating,
    tripCount: stats.tripCount,
    ...(showPhone && user?.phone && user.phoneVerifiedAt && { phone: user.phone }),
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
    ...(viewer !== 'GUEST' && {
      payout: { hostPayoutCents: price.hostPayoutCents, platformFeeCents: price.platformFeeCents },
    }),
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
          ...(booking.cancellationFeeCents !== undefined && { feeCents: booking.cancellationFeeCents }),
          ...(viewer !== 'GUEST' &&
            booking.hostShareCents !== undefined && { hostShareCents: booking.hostShareCents }),
          ...(viewer !== 'GUEST' &&
            booking.hostCancellationFeeCents !== undefined && {
              hostFeeCents: booking.hostCancellationFeeCents,
            }),
        }
      : null,
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
