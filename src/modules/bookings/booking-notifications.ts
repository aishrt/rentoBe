import type { ClientSession } from 'mongoose';
import { env } from '../../env.js';
import { formatNzDateTime, formatNzdExact } from '../../lib/format.js';
import { notify } from '../notifications/notify.js';
import type { CancellationOutcome } from './policies.js';
import { toBookingView, type BookingContext, type BookingRecord } from './booking-view.js';

/*
 * The booking notifications in plan §7: the Host hears about a booking by email, SMS and in-app;
 * the Guest gets the request, confirmation, decline, expiry, cancellation and refund emails. Each has
 * a dedupe key, so a job or webhook that runs again never notifies twice.
 */

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const tripUrl = (booking: BookingRecord) => `${siteUrl()}/trips/${booking.ref}`;
const hostBookingUrl = (booking: BookingRecord) => `${siteUrl()}/host/bookings/${booking.ref}`;

function basics(booking: BookingRecord) {
  return {
    ref: booking.ref,
    vehicleTitle: booking.vehicleSnapshot.title,
    start: formatNzDateTime(booking.startAt),
    end: formatNzDateTime(booking.endAt),
  };
}

const shortDates = (booking: BookingRecord) =>
  `${formatNzDateTime(booking.startAt).replace(/ \d{4},/, ',')} to ${formatNzDateTime(booking.endAt).replace(/ \d{4},/, ',')}`;

type Options = { session?: ClientSession };

/** A request to book: the Host decides within 24 h; the Guest knows it's sent (plan §8.2). */
export async function notifyRequestReceived(
  booking: BookingRecord,
  context: BookingContext,
  { session }: Options = {},
) {
  const guestName = context.guest?.firstName ?? 'A guest';
  const hostName = context.host?.firstName ?? 'the host';
  const expiresAt = formatNzDateTime(booking.requestExpiresAt!);
  const hostView = toBookingView(booking, context, 'HOST');

  await notify(
    {
      userId: booking.hostId,
      type: 'BOOKING_REQUEST',
      title: `Booking request from ${guestName}`,
      body: `${booking.vehicleSnapshot.title}, ${shortDates(booking)}. Answer by ${expiresAt}.`,
      link: `/host/bookings/${booking.ref}`,
      email: {
        template: 'bookingRequestHost',
        props: {
          ...basics(booking),
          firstName: hostName,
          guestFirstName: guestName,
          pickupLabel: hostView.pickup.label,
          payout: formatNzdExact(booking.price.hostPayoutCents),
          expiresAt,
          url: hostBookingUrl(booking),
        },
      },
      sms: {
        body: `Rento Vroom: ${guestName} wants to book your ${booking.vehicleSnapshot.title}, ${shortDates(booking)}. Accept or decline within 24 hours: ${hostBookingUrl(booking)}`,
      },
      dedupeKey: `BOOKING_REQUEST:${booking._id.toString()}`,
    },
    { session },
  );
  await notify(
    {
      userId: booking.guestId,
      type: 'BOOKING_REQUEST_SENT',
      title: `Your request is with ${hostName}`,
      body: `We'll let you know as soon as they answer. Your card isn't charged unless they accept.`,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'bookingRequestSent',
        props: {
          ...basics(booking),
          firstName: context.guest?.firstName ?? 'there',
          hostFirstName: hostName,
          total: formatNzdExact(booking.price.totalCents),
          expiresAt,
          url: tripUrl(booking),
        },
      },
      dedupeKey: `BOOKING_REQUEST_SENT:${booking._id.toString()}`,
    },
    { session },
  );
}

/** Confirmation to both parties (spec §7, step 11). */
export async function notifyConfirmed(
  booking: BookingRecord,
  context: BookingContext,
  { session }: Options = {},
) {
  const guestView = toBookingView(booking, context, 'GUEST');
  const hostView = toBookingView(booking, context, 'HOST');
  const guestName = context.guest?.firstName ?? 'A guest';
  const hostName = context.host?.firstName ?? 'your host';

  await notify(
    {
      userId: booking.guestId,
      type: 'BOOKING_CONFIRMED',
      title: `You're booked: ${booking.vehicleSnapshot.title}`,
      body: shortDates(booking),
      link: `/trips/${booking.ref}`,
      email: {
        template: 'bookingConfirmedGuest',
        props: {
          ...basics(booking),
          firstName: context.guest?.firstName ?? 'there',
          hostFirstName: hostName,
          ...(guestView.host.phone && { hostPhone: guestView.host.phone }),
          pickupLabel: guestView.pickup.label,
          ...(guestView.pickup.address && { pickupAddress: guestView.pickup.address }),
          ...(guestView.pickup.instructions && { pickupInstructions: guestView.pickup.instructions }),
          total: formatNzdExact(booking.price.totalCents),
          url: tripUrl(booking),
          // The email must be confirmed before the first trip starts (plan §6.1).
          ...(!context.guest?.emailVerifiedAt && { verifyEmailUrl: `${siteUrl()}/account/settings` }),
        },
      },
      dedupeKey: `BOOKING_CONFIRMED:${booking._id.toString()}:guest`,
    },
    { session },
  );
  await notify(
    {
      userId: booking.hostId,
      type: 'BOOKING_CONFIRMED',
      title: `${guestName} has booked your ${booking.vehicleSnapshot.title}`,
      body: shortDates(booking),
      link: `/host/bookings/${booking.ref}`,
      email: {
        template: 'bookingConfirmedHost',
        props: {
          ...basics(booking),
          firstName: hostName,
          guestFirstName: guestName,
          ...(hostView.guest.phone && { guestPhone: hostView.guest.phone }),
          pickupLabel: hostView.pickup.label,
          payout: formatNzdExact(booking.price.hostPayoutCents),
          url: hostBookingUrl(booking),
        },
      },
      // A request the Host just accepted needs no text; an Instant Book is news to them.
      ...(booking.instantBook && {
        sms: {
          body: `Rento Vroom: ${guestName} has booked your ${booking.vehicleSnapshot.title}, ${shortDates(booking)}. Details: ${hostBookingUrl(booking)}`,
        },
      }),
      dedupeKey: `BOOKING_CONFIRMED:${booking._id.toString()}:host`,
    },
    { session },
  );
}

/** A request the Host declined, or that expired unanswered (plan §8.2). */
export async function notifyRequestEnded(
  booking: BookingRecord,
  context: BookingContext,
  outcome: 'DECLINED' | 'EXPIRED',
  { session }: Options = {},
) {
  await notify(
    {
      userId: booking.guestId,
      type: outcome === 'DECLINED' ? 'BOOKING_DECLINED' : 'BOOKING_EXPIRED',
      title: outcome === 'DECLINED' ? 'Your request was declined' : 'Your request expired',
      body: `${booking.vehicleSnapshot.title}. Your card hasn't been charged.`,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'bookingDeclined',
        props: {
          firstName: context.guest?.firstName ?? 'there',
          vehicleTitle: booking.vehicleSnapshot.title,
          start: formatNzDateTime(booking.startAt),
          outcome,
          searchUrl: `${siteUrl()}/cars`,
        },
      },
      dedupeKey: `REQUEST_${outcome}:${booking._id.toString()}:guest`,
    },
    { session },
  );
  if (outcome === 'EXPIRED') {
    await notify(
      {
        userId: booking.hostId,
        type: 'BOOKING_EXPIRED',
        title: `${context.guest?.firstName ?? 'A guest'}'s request expired`,
        body: 'The dates are free again.',
        link: `/host/bookings/${booking.ref}`,
        email: {
          template: 'requestExpiredHost',
          props: {
            firstName: context.host?.firstName ?? 'there',
            guestFirstName: context.guest?.firstName ?? 'A guest',
            vehicleTitle: booking.vehicleSnapshot.title,
            url: `${siteUrl()}/host/bookings`,
          },
        },
        dedupeKey: `REQUEST_EXPIRED:${booking._id.toString()}:host`,
      },
      { session },
    );
  }
}

/** Cancellation to both parties, and the refund to the Guest (plan §7, §8.1 item 10). */
export async function notifyCancelled(
  booking: BookingRecord,
  context: BookingContext,
  outcome: CancellationOutcome,
  cancelledBy: 'GUEST' | 'HOST' | 'SUPPORT',
  { session }: Options = {},
) {
  const id = booking._id.toString();
  const withdrawn = outcome.kind === 'WITHDRAW_REQUEST';
  await notify(
    {
      userId: booking.guestId,
      type: withdrawn ? 'REQUEST_WITHDRAWN' : 'BOOKING_CANCELLED',
      title: withdrawn ? 'Your request is withdrawn' : `Booking ${booking.ref} is cancelled`,
      body:
        outcome.refundCents > 0
          ? `${formatNzdExact(outcome.refundCents)} is on its way back to your card.`
          : undefined,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'bookingCancelled',
        props: {
          ...basics(booking),
          firstName: context.guest?.firstName ?? 'there',
          audience: 'GUEST',
          cancelledBy,
          ...(outcome.refundCents > 0 && { refund: formatNzdExact(outcome.refundCents) }),
          ...(outcome.feeCents > 0 && { fee: formatNzdExact(outcome.feeCents) }),
          url: tripUrl(booking),
        },
      },
      dedupeKey: `BOOKING_CANCELLED:${id}:guest`,
    },
    { session },
  );
  await notify(
    {
      userId: booking.hostId,
      type: withdrawn ? 'REQUEST_WITHDRAWN' : 'BOOKING_CANCELLED',
      title: withdrawn
        ? `${context.guest?.firstName ?? 'The guest'} withdrew their request`
        : `Booking ${booking.ref} is cancelled`,
      body: 'The dates are free again.',
      link: `/host/bookings/${booking.ref}`,
      email: {
        template: 'bookingCancelled',
        props: {
          ...basics(booking),
          firstName: context.host?.firstName ?? 'there',
          audience: 'HOST',
          cancelledBy,
          ...(outcome.hostShareCents > 0 && { hostShare: formatNzdExact(outcome.hostShareCents) }),
          ...(outcome.hostFeeCents > 0 && { hostFee: formatNzdExact(outcome.hostFeeCents) }),
          url: hostBookingUrl(booking),
        },
      },
      dedupeKey: `BOOKING_CANCELLED:${id}:host`,
    },
    { session },
  );
  if (outcome.refundCents > 0) {
    await notify(
      {
        userId: booking.guestId,
        type: 'REFUND_ISSUED',
        title: `${formatNzdExact(outcome.refundCents)} refunded`,
        link: `/trips/${booking.ref}`,
        email: {
          template: 'refundIssued',
          props: {
            firstName: context.guest?.firstName ?? 'there',
            ref: booking.ref,
            vehicleTitle: booking.vehicleSnapshot.title,
            amount: formatNzdExact(outcome.refundCents),
            url: tripUrl(booking),
          },
        },
        dedupeKey: `REFUND_ISSUED:${id}`,
      },
      { session },
    );
  }
}

/** The first failed payment for a booking: a link back while the dates are still held (plan §8.1, item 6). */
export async function notifyPaymentFailed(
  booking: BookingRecord,
  context: BookingContext,
  reason: string | undefined,
  { session }: Options = {},
) {
  if (!booking.holdExpiresAt) return;
  await notify(
    {
      userId: booking.guestId,
      type: 'PAYMENT_FAILED',
      title: "Your payment didn't go through",
      body: reason,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'paymentFailed',
        props: {
          firstName: context.guest?.firstName ?? 'there',
          vehicleTitle: booking.vehicleSnapshot.title,
          ...(reason && { reason: reason.replace(/\.$/, '').replace(/^./, (first) => first.toLowerCase()) }),
          retryUrl: tripUrl(booking),
          holdUntil: formatNzDateTime(booking.holdExpiresAt).replace(/^\w+, /, ''),
        },
      },
      dedupeKey: `PAYMENT_FAILED:${booking._id.toString()}`,
    },
    { session },
  );
}
