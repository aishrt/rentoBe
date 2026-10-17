import mongoose from 'mongoose';
import { formatNzDateTime } from '../../lib/format.js';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { resolveVerificationReview } from '../bookings/booking.service.js';
import type { IdentityReviewResult } from '../bookings/bookings.schemas.js';
import { env } from '../../env.js';
import { notify } from '../notifications/notify.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { licenceAwaitingReview } from '../users/driver-licence.service.js';
import { UserModel, type User } from '../users/user.model.js';
import { userDetail } from './admin-users.service.js';
import { assertNotOwnRecord } from './own-record.js';
import { getPlatformSettings } from './platform-settings.service.js';
import { recheckBookedTrips } from './verification-queue.service.js';

/**
 * A turned-down identity check doesn't end the Guest's confirmed trips (plan §8.2): support are alerted to
 * each, to contact the Guest and decide. With their licence turned down, or still waiting for its check (one
 * that comes after the ID, so nobody makes it now), check-in refuses the trip; with it approved, the trip can
 * start. Returns the trips, and whether check-in refuses them.
 */
async function alertBookedTrips(
  user: Pick<User, 'firstName' | 'driverLicence'> & { _id: mongoose.Types.ObjectId },
  now: Date,
): Promise<{ refs: string[]; checkInRefused: boolean }> {
  const trips = await BookingModel.find({
    guestId: user._id,
    status: 'CONFIRMED',
    endAt: mongoose.trusted({ $gt: now }),
  })
    .sort({ startAt: 1 })
    .select('ref startAt')
    .lean();
  const licence = user.driverLicence?.status;
  for (const trip of trips) {
    const booking = `their confirmed booking ${trip.ref}, starting ${formatNzDateTime(trip.startAt)}`;
    await alertStaff({
      type: 'IDENTITY_REJECTED_BOOKED_TRIP',
      title: `Identity check turned down before ${trip.ref}`,
      body:
        licence === 'APPROVED'
          ? `${user.firstName}'s identity check was turned down, but their driver licence is approved, so ${booking}, can still be checked in. Contact the guest, and cancel the booking if the trip shouldn't go ahead.`
          : `${user.firstName}'s identity check was turned down, and their driver licence ${licence === 'REJECTED' ? 'was turned down too' : 'waits for a check that comes after their ID'}, so check-in for ${booking}, is refused. Contact the guest: allow another identity check from their record, or cancel the booking if the trip can't go ahead.`,
      link: `/admin/bookings/${trip.ref}`,
      dedupeKey: `IDENTITY_REJECTED_BOOKED_TRIP:${trip._id.toString()}:${now.getTime()}`,
    });
  }
  return { refs: trips.map((trip) => trip.ref), checkInRefused: licence !== 'APPROVED' };
}

/**
 * Support decides an identity check that needed a manual review (plan §8.2). The Guest's bookings that
 * waited for it are confirmed or released in the same step; turning it down leaves their confirmed trips
 * booked, and alerts support to each (alertBookedTrips). The review queue that lists these checks arrives
 * with the identity check itself (plan §9, Days 19–20); this is what its buttons call.
 */
export async function reviewIdentity(
  userId: string,
  decision: 'APPROVE' | 'REJECT',
  staffId: string,
  note?: string,
  ip?: string,
  now = new Date(),
): Promise<IdentityReviewResult> {
  const user = mongoose.isValidObjectId(userId) ? await UserModel.findById(userId) : null;
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'No such user.');
  await assertNotOwnRecord(staffId, [user._id]);
  if (user.identityVerification?.status !== 'PENDING') {
    throw new HttpError(409, 'NOT_IN_REVIEW', "This person's identity check isn't waiting for a review.");
  }

  const identityStatus: 'APPROVED' | 'REJECTED' = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  // The rest of the check stays: when it began (a turned-down check's images are redacted 90 days after,
  // plan §14), the document and how it compared, and any earlier checks still to redact.
  const identity = user.identityVerification;
  identity.status = identityStatus;
  identity.reviewedBy = new mongoose.Types.ObjectId(staffId);
  identity.lastError = undefined;
  if (decision === 'APPROVE') identity.verifiedAt = now;
  await user.save();
  await recordAudit({
    actorId: staffId,
    action: decision === 'APPROVE' ? 'identity.approved' : 'identity.rejected',
    entity: 'user',
    entityId: user.id,
    after: { status: identityStatus, ...(note && { note }) },
    ip,
  });

  const outcome = await resolveVerificationReview(user.id, decision, staffId, now);
  const booked = decision === 'REJECT' ? await alertBookedTrips(user, now) : null;
  const stillBooked = booked?.refs ?? [];
  const result = { identityStatus, ...outcome, ...(stillBooked.length > 0 && { stillBooked }) };
  // Bookings that still wait, for their licence check (plan §8.2).
  const stillWaiting = result.stillInReview ?? [];
  const bookedLine =
    stillBooked.length === 0
      ? null
      : booked?.checkInRefused
        ? `Your booking ${stillBooked.join(', ')} is still booked, but it can’t start until this is sorted out.`
        : `Your booking ${stillBooked.join(', ')} is still booked. Our team will be in touch about it.`;
  await notify({
    userId: user._id,
    type: decision === 'APPROVE' ? 'IDENTITY_APPROVED' : 'IDENTITY_REJECTED',
    title: decision === 'APPROVE' ? 'Your identity is verified' : 'We couldn’t verify your identity',
    body:
      decision === 'APPROVE'
        ? result.confirmed.length > 0
          ? `Booking ${result.confirmed.join(', ')} is confirmed.`
          : stillWaiting.length > 0
            ? `Booking ${stillWaiting.join(', ')} waits for our check of your driver licence.`
            : 'You’re all set to book.'
        : `Any booking waiting for the check was released.${bookedLine ? ` ${bookedLine}` : ''} Contact support if you have questions.`,
    link: '/account',
    email: {
      template: 'tripNotice',
      props: {
        firstName: user.firstName,
        heading: decision === 'APPROVE' ? 'Your identity is verified' : 'We couldn’t verify your identity',
        paragraphs:
          decision === 'APPROVE'
            ? [
                'Our team has finished checking your ID, and you’re verified.',
                ...(result.confirmed.length > 0
                  ? [`Your booking ${result.confirmed.join(', ')} is confirmed.`]
                  : []),
                ...(stillWaiting.length > 0
                  ? [
                      `Your booking ${stillWaiting.join(', ')} is still held for you while we check your driver licence, usually within a few hours. Your card isn’t charged until it’s approved.`,
                    ]
                  : []),
              ]
            : [
                'Our team couldn’t verify your identity from the ID and selfie you sent, so you can’t book a car for now.',
                ...(result.released.length > 0
                  ? [
                      `Booking ${result.released.join(', ')} was released, and your card authorisation with it: nothing was charged.`,
                    ]
                  : []),
                ...(bookedLine ? [bookedLine] : []),
                bookedLine
                  ? 'Reply to this email and our team will help, including if you think this is a mistake.'
                  : 'If you think this is a mistake, reply to this email.',
              ],
        buttonLabel: 'Your account',
        url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/account`,
      },
    },
    dedupeKey: `IDENTITY_REVIEWED:${user.id}:${now.getTime()}`,
  });
  return result;
}

/**
 * What the turned-down check found, cleared so the next one starts afresh (its own result replaces it). The
 * licence number its ID showed stays, so the account still turns up with others that have that licence (plan
 * §3); without `documentType` it no longer confirms a licence (saveDriverLicence).
 */
const CHECK_RESULT_FIELDS = [
  'providerRef',
  'sessionStatus',
  'lastError',
  'reviewReason',
  'documentType',
  'documentDobMatched',
  'documentDobHash',
  'startedAt',
  'verifiedAt',
  'reviewedBy',
  'redactedAt',
] as const;

/**
 * POST /admin/users/{id}/verification-reset: support let the member try again after turning down their
 * identity check or licence (they asked, or it was a mistake), so a rejection isn't a dead end. The identity
 * check starts afresh: the turned-down session moves to the earlier ones, still redacted 90 days after it began
 * (plan §14), and the member can start a new check. The licence goes back to support's queue as it is (PENDING:
 * a licence has no "not entered" state), for the member to correct first if they need to; their booked trips
 * wait for the check again (plan §8.2). Written to the audit log with the reason, and the member is told. 409
 * NOT_REJECTED when that check wasn't turned down, ACCOUNT_CLOSED for a closed account, IDENTITY_FIRST for a
 * licence that wouldn't reach the queue (their identity check was turned down, or is still to do while it comes
 * first): it would wait unchecked, and the ID check could confirm it without support; 403 OWN_RECORD for a
 * support member's own record.
 */
export async function allowVerificationRetry(
  userId: string,
  kind: 'IDENTITY' | 'LICENCE',
  reason: string,
  staffId: string,
  ip?: string,
  now = new Date(),
) {
  const user = mongoose.isValidObjectId(userId)
    ? await UserModel.findById(userId)
        .select('firstName closedAt identityVerification driverLicence updatedAt')
        .lean()
    : null;
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'No such user.');
  await assertNotOwnRecord(staffId, [user._id]);
  if (user.closedAt) {
    throw new HttpError(
      409,
      'ACCOUNT_CLOSED',
      'This account was closed at the member’s request, so there’s nothing to check again.',
    );
  }
  const notRejected = () =>
    new HttpError(
      409,
      'NOT_REJECTED',
      kind === 'IDENTITY'
        ? "This person's identity check wasn't turned down, so there's nothing to reopen."
        : "This person's licence wasn't turned down, so there's nothing to reopen.",
    );

  const identity = user.identityVerification;
  if (kind === 'IDENTITY') {
    if (identity?.status !== 'REJECTED') throw notRejected();
    // A check from before start dates were kept counts from the account's last change, which is no later than
    // now, so its redaction isn't put off (plan §14).
    const earlier =
      identity.providerRef && !identity.redactedAt
        ? { providerRef: identity.providerRef, startedAt: identity.startedAt ?? user.updatedAt ?? now }
        : undefined;
    // Reopened once, even when two staff members do it at the same moment.
    const reopened = await UserModel.updateOne(
      { _id: user._id, 'identityVerification.status': 'REJECTED' },
      {
        $set: { 'identityVerification.status': 'NONE' },
        $unset: Object.fromEntries(CHECK_RESULT_FIELDS.map((field) => [`identityVerification.${field}`, 1])),
        ...(earlier && { $push: { 'identityVerification.earlierSessions': earlier } }),
      },
    );
    if (reopened.modifiedCount === 0) throw notRejected();
  } else {
    if (user.driverLicence?.status !== 'REJECTED') throw notRejected();
    // Back to PENDING, the licence has to be one support's queue lists: check-in refuses it until it's approved.
    const settings = await getPlatformSettings();
    if (
      !licenceAwaitingReview(
        { ...user, driverLicence: { ...user.driverLicence, status: 'PENDING' } },
        settings,
      )
    ) {
      throw new HttpError(
        409,
        'IDENTITY_FIRST',
        identity?.status === 'REJECTED'
          ? 'Allow another identity check first: their licence is checked once their ID is.'
          : 'Their identity check comes first: their licence is checked once their ID is.',
      );
    }
    const reopened = await UserModel.updateOne(
      { _id: user._id, 'driverLicence.status': 'REJECTED' },
      { $set: { 'driverLicence.status': 'PENDING' }, $unset: { 'driverLicence.reviewedBy': 1 } },
    );
    if (reopened.modifiedCount === 0) throw notRejected();
  }
  await recordAudit({
    actorId: staffId,
    action: kind === 'IDENTITY' ? 'identity.reopened' : 'licence.reopened',
    entity: 'user',
    entityId: user._id.toString(),
    before:
      kind === 'IDENTITY'
        ? {
            status: 'REJECTED',
            ...(identity?.providerRef && { session: identity.providerRef }),
            ...(identity?.reviewReason && { reviewReason: identity.reviewReason }),
            ...(identity?.documentType && { documentType: identity.documentType }),
          }
        : { status: 'REJECTED' },
    after: { status: kind === 'IDENTITY' ? 'NONE' : 'PENDING', reason },
    ...(ip && { ip }),
  });
  // The licence is with support again (or, with no identity check needed, now waits for them): so are the trips
  // it decides (plan §8.2).
  await recheckBookedTrips(user._id.toString(), now, { reopened: kind === 'LICENCE' });

  const accountUrl = `${env.FRONTEND_URL.replace(/\/+$/, '')}/account`;
  await notify({
    userId: user._id,
    ...(kind === 'IDENTITY'
      ? {
          type: 'IDENTITY_RETRY_ALLOWED',
          title: 'You can try your identity check again',
          body: 'Start it again from your account: a photo of your ID and a quick selfie.',
          email: {
            template: 'tripNotice' as const,
            props: {
              firstName: user.firstName,
              heading: 'You can try your identity check again',
              paragraphs: [
                'Our team has had another look, and you can now do your identity check again.',
                'It takes a couple of minutes: a photo of your driver licence (or passport) and a quick selfie, on Stripe’s secure page. Good light and the whole card in the frame help.',
              ],
              buttonLabel: 'Verify your identity',
              url: accountUrl,
            },
          },
        }
      : {
          type: 'LICENCE_RECHECK',
          title: 'We’ll check your driver licence again',
          body: 'Our team is taking another look at your licence details. Update them from your account if something was entered wrongly.',
          email: {
            template: 'tripNotice' as const,
            props: {
              firstName: user.firstName,
              heading: 'We’ll check your driver licence again',
              paragraphs: [
                'Our team is taking another look at the driver licence details on your account, usually within a few hours.',
                'If something was entered wrongly, update it from your account first, and we’ll check the new details. We’ll email you when it’s done.',
              ],
              buttonLabel: 'Check your details',
              url: accountUrl,
            },
          },
        }),
    link: '/account',
    dedupeKey: `${kind}_REOPENED:${user._id.toString()}:${now.getTime()}`,
  });
  return userDetail(userId);
}
