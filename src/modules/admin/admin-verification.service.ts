import mongoose from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { resolveVerificationReview } from '../bookings/booking.service.js';
import type { IdentityReviewResult } from '../bookings/bookings.schemas.js';
import { env } from '../../env.js';
import { notify } from '../notifications/notify.js';
import { UserModel } from '../users/user.model.js';

/**
 * Support decides an identity check that needed a manual review (plan §8.2). The Guest's bookings that
 * waited for it are confirmed or released in the same step. The review queue that lists these checks
 * arrives with the identity check itself (plan §9, Days 19–20); this is what its buttons call.
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
  if (user.identityVerification?.status !== 'PENDING') {
    throw new HttpError(409, 'NOT_IN_REVIEW', "This person's identity check isn't waiting for a review.");
  }

  const identityStatus: 'APPROVED' | 'REJECTED' = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  user.identityVerification = {
    ...(user.identityVerification.provider && { provider: user.identityVerification.provider }),
    ...(user.identityVerification.providerRef && { providerRef: user.identityVerification.providerRef }),
    status: identityStatus,
    reviewedBy: new mongoose.Types.ObjectId(staffId),
    ...(decision === 'APPROVE' && { verifiedAt: now }),
  };
  await user.save();
  await recordAudit({
    actorId: staffId,
    action: decision === 'APPROVE' ? 'identity.approved' : 'identity.rejected',
    entity: 'user',
    entityId: user.id,
    after: { status: identityStatus, ...(note && { note }) },
    ip,
  });

  const result = { identityStatus, ...(await resolveVerificationReview(user.id, decision, staffId, now)) };
  await notify({
    userId: user._id,
    type: decision === 'APPROVE' ? 'IDENTITY_APPROVED' : 'IDENTITY_REJECTED',
    title: decision === 'APPROVE' ? 'Your identity is verified' : 'We couldn’t verify your identity',
    body:
      decision === 'APPROVE'
        ? result.confirmed.length > 0
          ? `Booking ${result.confirmed.join(', ')} is confirmed.`
          : 'You’re all set to book.'
        : 'Any booking waiting for the check was released. Contact support if you have questions.',
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
              ]
            : [
                'Our team couldn’t verify your identity from the ID and selfie you sent, so you can’t book a car for now.',
                ...(result.released.length > 0
                  ? [
                      `Booking ${result.released.join(', ')} was released, and your card authorisation with it: nothing was charged.`,
                    ]
                  : []),
                'If you think this is a mistake, reply to this email.',
              ],
        buttonLabel: 'Your account',
        url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/account`,
      },
    },
    dedupeKey: `IDENTITY_REVIEWED:${user.id}:${now.getTime()}`,
  });
  return result;
}
