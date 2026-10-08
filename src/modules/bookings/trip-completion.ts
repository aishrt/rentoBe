import type { ClientSession, Types } from 'mongoose';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import type { ConditionReport } from '../inspections/condition-report.model.js';
import { notify } from '../notifications/notify.js';
import { queueReviewJobs } from '../reviews/reviews.service.js';
import { UserModel } from '../users/user.model.js';
import type { Booking } from './booking.model.js';

/*
 * What follows a completed trip (plan §4.3, §8.2): both parties hear it's done, the extra-kilometre
 * charge is worked out, the review requests go out and the Host's payout is checked. Runs inside the
 * transaction that completes the booking, so it only writes to the database and queues jobs.
 */

type Id = Types.ObjectId;
type Report = ConditionReport & { _id: Id };

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

export async function afterTripCompleted(
  booking: Booking & { _id: Id },
  _reports: { checkIn: Report; checkOut: Report } | null,
  session: ClientSession,
  now = new Date(),
): Promise<void> {
  const [guest, host] = await Promise.all([
    UserModel.findById(booking.guestId).select('firstName').session(session).lean(),
    UserModel.findById(booking.hostId).select('firstName').session(session).lean(),
  ]);
  const id = booking._id.toString();
  // Extra kilometres are worked out from the condition reports and charged (plan §4.3).
  await enqueue(
    'trip.extraCharges',
    { bookingId: id },
    { uniqueKey: `trip.extraCharges:${id}`, refId: id, session },
  );
  // Both sides are asked for a review, revealed together when the window closes (spec §16).
  await queueReviewJobs(booking, session, now);
  await notify(
    {
      userId: booking.guestId,
      type: 'TRIP_COMPLETED',
      title: 'Trip completed',
      body: `Thanks for travelling in the ${booking.vehicleSnapshot.title}.`,
      link: `/trips/${booking.ref}`,
      email: {
        template: 'tripNotice',
        props: {
          firstName: guest?.firstName ?? 'there',
          heading: 'Thanks for travelling with Rento Vroom',
          paragraphs: [
            `Your trip in the ${booking.vehicleSnapshot.title} is complete, and ${host?.firstName ?? 'your host'} has the car back.`,
            'Your receipt and the check-out photos are on the trip. Any extra kilometres are charged to your saved card, and you’ll get a receipt if they are.',
          ],
          rows: [{ label: 'Booking', value: booking.ref }],
          buttonLabel: 'View your trip',
          url: `${siteUrl()}/trips/${booking.ref}`,
        },
      },
      dedupeKey: `TRIP_COMPLETED:${id}:GUEST`,
    },
    { session },
  );
  await notify(
    {
      userId: booking.hostId,
      type: 'TRIP_COMPLETED',
      title: `${guest?.firstName ?? 'Your guest'}'s trip is complete`,
      body: `The ${booking.vehicleSnapshot.title} is back. Flag any new damage within the damage-report window.`,
      link: `/host/bookings/${booking.ref}`,
      dedupeKey: `TRIP_COMPLETED:${id}:HOST`,
    },
    { session },
  );
}
