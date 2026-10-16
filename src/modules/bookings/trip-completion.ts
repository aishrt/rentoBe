import mongoose, { type ClientSession, type Types } from 'mongoose';
import { env } from '../../env.js';
import { JobModel } from '../../jobs/job.model.js';
import { enqueue } from '../../jobs/queue.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
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
const HOUR_MS = 60 * 60 * 1000;

/** The one `trip.extraCharges` job a booking has. */
export const extraKmJobKey = (bookingId: string) => `trip.extraCharges:${bookingId}`;

/**
 * When the extra kilometres are charged (plan §8.2: the other party reviews and confirms the check-out). A
 * check-out waits for the other party's confirmation (extraKmConfirmed brings it forward) or the end of the
 * damage-report window, so a mistyped reading can be put right first. The Host's readings that staff entered
 * to complete a trip wait the same way, for the Guest's confirmation; staff with the refunds permission can
 * charge them at once (POST /admin/bookings/{id}/extra-km).
 */
async function extraKmChargeAt(checkOut: Report | undefined, now: Date): Promise<Date> {
  if (!checkOut) return now;
  const settings = await getPlatformSettings();
  return new Date(checkOut.createdAt.getTime() + settings.trips.damageReportWindowHours * HOUR_MS);
}

/** The other party confirmed the check-out readings: the extra kilometres are charged now. */
export async function extraKmConfirmed(bookingId: string, now = new Date()): Promise<void> {
  await JobModel.updateOne(
    { uniqueKey: extraKmJobKey(bookingId), status: 'QUEUED', runAt: mongoose.trusted({ $gt: now }) },
    { $set: { runAt: now } },
  );
}

export async function afterTripCompleted(
  booking: Booking & { _id: Id },
  reports: { checkIn: Report; checkOut: Report } | null,
  session: ClientSession,
  now = new Date(),
): Promise<void> {
  const [guest, host] = await Promise.all([
    UserModel.findById(booking.guestId).select('firstName').session(session).lean(),
    UserModel.findById(booking.hostId).select('firstName').session(session).lean(),
  ]);
  const id = booking._id.toString();
  // Extra kilometres are worked out from the condition reports and charged (plan §3, §4.3), once the
  // readings are confirmed or the damage-report window closes.
  await enqueue(
    'trip.extraCharges',
    { bookingId: id },
    {
      runAt: await extraKmChargeAt(reports?.checkOut, now),
      uniqueKey: extraKmJobKey(id),
      refId: id,
      session,
    },
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
            'Your receipt and the check-out photos are on the trip. Any extra kilometres are charged to your saved card once the check-out readings are confirmed, and you’ll get a receipt if they are.',
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
