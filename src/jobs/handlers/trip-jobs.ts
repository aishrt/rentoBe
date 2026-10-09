import { env } from '../../env.js';
import { formatNzDateTime } from '../../lib/format.js';
import { BookingModel } from '../../modules/bookings/booking.model.js';
import {
  loadBookingContext,
  toBookingView,
  type BookingRecord,
} from '../../modules/bookings/booking-view.js';
import { postSystemMessage } from '../../modules/messages/thread-core.js';
import { notify } from '../../modules/notifications/notify.js';
import {
  requestReviews,
  runReviewReveal,
  sweepReviewReveals,
} from '../../modules/reviews/reviews.service.js';
import { alertStaff } from '../../modules/staff/staff-alerts.js';
import type { JobContext } from './index.js';

/*
 * Trip jobs (plan §4.3, §8.2): pickup and return reminders by email, SMS and in the booking's chat, and
 * the checks for a missing check-in and a late return. Each checks the booking first, so a reminder for a
 * trip that moved on (cancelled, already checked in or out) does nothing.
 */

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
/** "10:00 am" style, for chat messages and texts. */
const nzTime = (instant: Date) => formatNzDateTime(instant).replace(/^.*, /, '');

function inWords(hours: number) {
  return hours >= 24 ? 'Tomorrow' : hours === 1 ? 'In 1 hour' : `In ${hours} hours`;
}

async function loadTrip(bookingId: string) {
  const booking = await BookingModel.findById(bookingId).lean<BookingRecord>();
  if (!booking) return null;
  const context = await loadBookingContext(booking);
  return {
    booking,
    context,
    guestView: toBookingView(booking, context, 'GUEST'),
    hostView: toBookingView(booking, context, 'HOST'),
  };
}

/** `reminder.pickup`: 24 h and 2 h before the trip starts, while it's confirmed and not yet checked in. */
export async function pickupReminderJob(
  { bookingId, hoursBefore }: { bookingId: string; hoursBefore: number },
  { log }: JobContext,
) {
  const trip = await loadTrip(bookingId);
  if (!trip || trip.booking.status !== 'CONFIRMED') return;
  const { booking, context, guestView, hostView } = trip;
  const guestName = context.guest?.firstName ?? 'your guest';
  const hostName = context.host?.firstName ?? 'your host';
  const when = formatNzDateTime(booking.startAt);
  const words = inWords(hoursBefore);
  const place = guestView.pickup.address ?? guestView.pickup.label;
  const soon = hoursBefore <= 3;
  const key = `${booking._id.toString()}:${hoursBefore}`;
  const guestUrl = `${siteUrl()}/trips/${booking.ref}`;

  await notify({
    userId: booking.guestId,
    type: 'PICKUP_REMINDER',
    title: `${words}: pick up the ${booking.vehicleSnapshot.title}`,
    body: `${when} (NZ time) at ${place}.`,
    link: `/trips/${booking.ref}`,
    ...(!soon && {
      email: {
        template: 'tripReminder',
        props: {
          firstName: context.guest?.firstName ?? 'there',
          role: 'GUEST',
          kind: 'PICKUP',
          otherFirstName: hostName,
          ref: booking.ref,
          vehicleTitle: booking.vehicleSnapshot.title,
          when,
          inWords: words,
          place,
          url: guestUrl,
          ...(!context.guest?.emailVerifiedAt && { verifyEmailUrl: `${siteUrl()}/account/settings` }),
        },
      },
    }),
    sms: {
      // The day-before text may wait for the end of quiet hours, so it names the day rather than "tomorrow".
      body: soon
        ? `Rento Vroom: ${words.toLowerCase()} you pick up the ${booking.vehicleSnapshot.title} at ${nzTime(booking.startAt)}, ${place}. Check in with ${hostName}: ${guestUrl}`
        : `Rento Vroom: you pick up the ${booking.vehicleSnapshot.title} on ${when}, ${place}. Check in with ${hostName}: ${guestUrl}`,
      // A pickup within 3 hours is sent straight away, even in quiet hours (plan §7).
      urgent: soon,
      whileBooking: { id: booking._id, statuses: ['CONFIRMED'] },
      expiresAt: booking.startAt,
    },
    dedupeKey: `PICKUP_REMINDER:${key}`,
  });

  await notify({
    userId: booking.hostId,
    type: 'PICKUP_REMINDER',
    title: `${words}: ${guestName} picks up your ${booking.vehicleSnapshot.title}`,
    body: `${when} (NZ time) at ${hostView.pickup.address ?? hostView.pickup.label}.`,
    link: `/host/bookings/${booking.ref}`,
    ...(!soon && {
      email: {
        template: 'tripReminder',
        props: {
          firstName: hostName,
          role: 'HOST',
          kind: 'PICKUP',
          otherFirstName: guestName,
          ref: booking.ref,
          vehicleTitle: booking.vehicleSnapshot.title,
          when,
          inWords: words,
          place: hostView.pickup.address ?? hostView.pickup.label,
          url: `${siteUrl()}/host/bookings/${booking.ref}`,
        },
      },
    }),
    ...(soon && {
      sms: {
        body: `Rento Vroom: ${guestName} picks up your ${booking.vehicleSnapshot.title} at ${nzTime(booking.startAt)}. Do the check-in together: ${siteUrl()}/host/bookings/${booking.ref}`,
        urgent: true,
      },
    }),
    dedupeKey: `PICKUP_REMINDER_HOST:${key}`,
  });

  await postSystemMessage(
    booking,
    `Reminder: pick-up is ${words.toLowerCase()}, ${when} (NZ time), at ${guestView.pickup.label}. Do the check-in photos together before driving away.`,
  );
  log.info({ bookingId, hoursBefore }, 'Pickup reminder sent');
}

/** `reminder.return`: 2 h before the trip ends, while it's under way. */
export async function returnReminderJob(
  { bookingId, hoursBefore }: { bookingId: string; hoursBefore: number },
  { log }: JobContext,
) {
  const trip = await loadTrip(bookingId);
  if (!trip || !['CONFIRMED', 'ACTIVE'].includes(trip.booking.status)) return;
  const { booking, context, guestView } = trip;
  const guestName = context.guest?.firstName ?? 'your guest';
  const when = formatNzDateTime(booking.endAt);
  const words = inWords(hoursBefore);
  const place = guestView.dropoff.address ?? guestView.dropoff.label;
  const key = `${booking._id.toString()}:${hoursBefore}`;
  const guestUrl = `${siteUrl()}/trips/${booking.ref}`;

  await notify({
    userId: booking.guestId,
    type: 'RETURN_REMINDER',
    title: `${words}: return the ${booking.vehicleSnapshot.title}`,
    body: `By ${when} (NZ time) at ${place}.`,
    link: `/trips/${booking.ref}`,
    email: {
      template: 'tripReminder',
      props: {
        firstName: context.guest?.firstName ?? 'there',
        role: 'GUEST',
        kind: 'RETURN',
        otherFirstName: context.host?.firstName ?? 'your host',
        ref: booking.ref,
        vehicleTitle: booking.vehicleSnapshot.title,
        when,
        inWords: words,
        place,
        url: guestUrl,
      },
    },
    // Not one of the texts that skip quiet hours (plan §7): one held past the return time isn't sent, and the
    // late-return text (urgent) follows instead.
    sms: {
      body: `Rento Vroom: please return the ${booking.vehicleSnapshot.title} by ${nzTime(booking.endAt)}, ${place}, and do the check-out: ${guestUrl}`,
      whileBooking: { id: booking._id, statuses: ['CONFIRMED', 'ACTIVE'] },
      expiresAt: booking.endAt,
    },
    dedupeKey: `RETURN_REMINDER:${key}`,
  });
  await notify({
    userId: booking.hostId,
    type: 'RETURN_REMINDER',
    title: `${words}: ${guestName} returns your ${booking.vehicleSnapshot.title}`,
    body: `By ${when} (NZ time).`,
    link: `/host/bookings/${booking.ref}`,
    dedupeKey: `RETURN_REMINDER_HOST:${key}`,
  });
  await postSystemMessage(
    booking,
    `Reminder: the car is due back ${words.toLowerCase()}, by ${when} (NZ time), at ${guestView.dropoff.label}. Do the check-out photos together when it's returned.`,
  );
  log.info({ bookingId, hoursBefore }, 'Return reminder sent');
}

/**
 * `trip.startCheck`: 1 h after the start without a check-in, both parties are reminded; after 2 h,
 * support is alerted to a possible no-show (plan §8.2).
 */
export async function startCheckJob(
  { bookingId, hoursAfter }: { bookingId: string; hoursAfter: number },
  { log }: JobContext,
) {
  const trip = await loadTrip(bookingId);
  if (!trip || trip.booking.status !== 'CONFIRMED') return;
  const { booking, context } = trip;
  const key = booking._id.toString();

  if (hoursAfter >= 2) {
    await alertStaff({
      type: 'TRIP_NO_CHECK_IN',
      title: `Possible no-show on ${booking.ref}`,
      body: `check-in on booking ${booking.ref} (${booking.vehicleSnapshot.title}) wasn't done 2 hours after the start time. Contact the guest and host, and cancel it as a no-show if the trip didn't go ahead.`,
      link: `/admin/bookings/${booking.ref}`,
      dedupeKey: `TRIP_NO_CHECK_IN:${key}`,
    });
    log.warn({ bookingId }, 'Check-in still missing; support alerted');
    return;
  }

  const rows = [
    { label: 'Car', value: booking.vehicleSnapshot.title },
    { label: 'Pick-up', value: `${formatNzDateTime(booking.startAt)} (NZ time)` },
    { label: 'Booking', value: booking.ref },
  ];
  for (const role of ['GUEST', 'HOST'] as const) {
    const me = role === 'GUEST' ? context.guest : context.host;
    const other = role === 'GUEST' ? context.host : context.guest;
    const path =
      role === 'GUEST' ? `/trips/${booking.ref}/check-in` : `/host/bookings/${booking.ref}/check-in`;
    await notify({
      userId: role === 'GUEST' ? booking.guestId : booking.hostId,
      type: 'CHECK_IN_MISSING',
      title: 'Check-in isn’t done yet',
      body: `The trip started an hour ago. Take the check-in photos with ${other?.firstName ?? 'the other party'}.`,
      link: path,
      email: {
        template: 'tripNotice',
        props: {
          firstName: me?.firstName ?? 'there',
          heading: 'Check-in isn’t done yet',
          paragraphs: [
            `The trip in the ${booking.vehicleSnapshot.title} started an hour ago, but the check-in photos haven’t been taken.`,
            role === 'GUEST'
              ? `Do the check-in with ${other?.firstName ?? 'your host'} before you drive away: it protects you both if anything is damaged. If they aren’t there, you can take the photos yourself and they confirm later.`
              : `Do the check-in with ${other?.firstName ?? 'your guest'}. If the trip isn’t going ahead, let us know so support can help.`,
          ],
          rows,
          buttonLabel: 'Start check-in',
          url: `${siteUrl()}${path}`,
        },
      },
      sms: {
        body: `Rento Vroom: check-in for ${booking.ref} isn't done yet. Take the photos before driving: ${siteUrl()}${path}`,
        urgent: true,
      },
      dedupeKey: `CHECK_IN_MISSING:${key}:${role}`,
    });
  }
  log.info({ bookingId }, 'Check-in missing; both parties reminded');
}

/**
 * `trip.returnCheck`: at the return time plus the grace period without a check-out, the Guest is reminded
 * and the Host told, who can report a late return; 24 h later support is alerted to complete the trip
 * (plan §8.2).
 */
export async function returnCheckJob(
  { bookingId, stage }: { bookingId: string; stage: 'GRACE' | 'DAY' },
  { log }: JobContext,
) {
  const trip = await loadTrip(bookingId);
  if (!trip || trip.booking.status !== 'ACTIVE') return;
  const { booking, context } = trip;
  const key = booking._id.toString();

  if (stage === 'DAY') {
    await alertStaff({
      type: 'TRIP_NO_CHECK_OUT',
      title: `Check-out missing on ${booking.ref}`,
      body: `the ${booking.vehicleSnapshot.title} on booking ${booking.ref} was due back 24 hours ago and check-out isn't done. Complete the trip from the booking's Handover section with the host's odometer and fuel reading and photos.`,
      // Straight to the booking's Handover section, where staff complete the trip (plan §8.2).
      link: `/admin/bookings/${booking.ref}#handover`,
      dedupeKey: `TRIP_NO_CHECK_OUT:${key}`,
    });
    log.warn({ bookingId }, 'Check-out still missing; support alerted');
    return;
  }

  const due = `${formatNzDateTime(booking.endAt)} (NZ time)`;
  const guestPath = `/trips/${booking.ref}/check-out`;
  await notify({
    userId: booking.guestId,
    type: 'LATE_RETURN',
    title: 'Your trip has ended',
    body: `The ${booking.vehicleSnapshot.title} was due back at ${due}. Return it and do the check-out.`,
    link: guestPath,
    email: {
      template: 'tripNotice',
      props: {
        firstName: context.guest?.firstName ?? 'there',
        heading: 'Your car was due back',
        paragraphs: [
          `The ${booking.vehicleSnapshot.title} was due back at ${due}, and check-out isn’t done yet.`,
          'Please return it as soon as you can and take the check-out photos with your host. A late return can lead to a late-return charge under the Guest Agreement.',
        ],
        buttonLabel: 'Start check-out',
        url: `${siteUrl()}${guestPath}`,
      },
    },
    sms: {
      body: `Rento Vroom: the ${booking.vehicleSnapshot.title} was due back at ${nzTime(booking.endAt)}. Please return it and do the check-out: ${siteUrl()}${guestPath}`,
      urgent: true,
    },
    dedupeKey: `LATE_RETURN:${key}`,
  });
  await notify({
    userId: booking.hostId,
    type: 'LATE_RETURN',
    title: `${context.guest?.firstName ?? 'Your guest'} hasn’t checked out`,
    body: `The ${booking.vehicleSnapshot.title} was due back at ${due}. You can report a late return from the booking.`,
    link: `/host/bookings/${booking.ref}`,
    email: {
      template: 'tripNotice',
      props: {
        firstName: context.host?.firstName ?? 'there',
        heading: 'Your car hasn’t been returned yet',
        paragraphs: [
          `${context.guest?.firstName ?? 'Your guest'} was due to return your ${booking.vehicleSnapshot.title} at ${due}, and check-out isn’t done.`,
          'We’ve reminded them. If the car still isn’t back, you can report a late return from the booking, and support will help.',
        ],
        buttonLabel: 'Open the booking',
        url: `${siteUrl()}/host/bookings/${booking.ref}`,
      },
    },
    dedupeKey: `LATE_RETURN_HOST:${key}`,
  });
  log.info({ bookingId }, 'Late return; guest reminded and host told');
}

/** `trip.reviewRequest`: after check-out, both sides are asked to review the trip (plan §4.3). */
export async function reviewRequestJob({ bookingId }: { bookingId: string }, { log }: JobContext) {
  await requestReviews(bookingId);
  log.info({ bookingId }, 'Review requests sent');
}

/**
 * `reviews.reveal`: the review window has closed; reviews still waiting are published (plan §4.3). Queued
 * again for the new close if staff have since lengthened the window.
 */
export async function revealReviewsJob({ bookingId }: { bookingId: string }, { log }: JobContext) {
  const published = await runReviewReveal(bookingId);
  log.info({ bookingId, published }, 'Reviews revealed');
}

/** `daily.reviewReveal`: publishes reviews still waiting after their window closed (the safety net). */
export async function reviewRevealSweepJob(_payload: Record<string, never>, { log }: JobContext) {
  const published = await sweepReviewReveals();
  log.info({ published }, 'Waiting reviews checked');
}
