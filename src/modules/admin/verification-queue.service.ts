import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../../env.js';
import { decrypt } from '../../lib/encryption.js';
import { HttpError } from '../../lib/http-error.js';
import { nzDate } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { resolveVerificationReview } from '../bookings/booking.service.js';
import { verificationOutcomeShape, type VerificationOutcome } from '../bookings/bookings.schemas.js';
import { notify } from '../notifications/notify.js';
import { UserModel, type User } from '../users/user.model.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * The support team's verification queue (spec §22; plan §9 Days 19–20): identity checks Stripe couldn't
 * decide, or whose document doesn't match what the person entered, then driver licences no document has
 * confirmed. Approving one confirms the bookings that waited for it once nothing else does (plan §8.2).
 * Staff compare the licence with the full number, shown on request and written to the audit log (plan §14).
 */

/** The licence details staff compare with the person's ID and date of birth. */
export const staffLicenceSchema = z.object({
  class: z.string(),
  country: z.string(),
  numberEnding: z.string(),
  version: z.string().optional(),
  expiry: z.string(),
  issuedAt: z.string().optional(),
  inEnglish: z
    .boolean()
    .optional()
    .meta({
      description: 'Overseas licences: false when it isn’t in English, which then needs English proof',
    }),
  englishProof: z.string().optional(),
  status: z.string(),
});

/** How the ID used in the identity check compared with the account. */
export const documentComparisonSchema = z.object({
  licenceNumberMatched: z.boolean().optional().meta({
    description:
      'A driver licence used as the ID: whether its number is the licence’s on the account now. Left out for another document',
  }),
  dobMatched: z
    .boolean()
    .optional()
    .meta({ description: 'Whether the date of birth on the ID matched the account’s when it was checked' }),
});

export const verificationItemSchema = z
  .object({
    userId: z.string(),
    kind: z.enum(['IDENTITY', 'LICENCE']),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    reason: z.string(),
    since: z.iso.datetime(),
    identity: z
      .object({ status: z.string(), documentType: z.string().optional() })
      .extend(documentComparisonSchema.shape),
    licence: staffLicenceSchema.nullable(),
    dob: z.string().optional(),
    riskFlags: z.array(z.string()),
    waitingBookings: z.array(
      z.object({ ref: z.string(), vehicleTitle: z.string(), expiresAt: z.iso.datetime().optional() }),
    ),
  })
  .meta({ id: 'VerificationQueueItem' });
export type VerificationItem = z.infer<typeof verificationItemSchema>;

export const verificationQueueSchema = z
  .object({ items: z.array(verificationItemSchema) })
  .meta({ id: 'VerificationQueue' });

export const licenceReviewSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'LicenceReviewRequest' });

export const licenceReviewResultSchema = z
  .object({ licenceStatus: z.enum(['APPROVED', 'REJECTED']), ...verificationOutcomeShape })
  .meta({ id: 'LicenceReviewResult' });
export type LicenceReviewResult = z.infer<typeof licenceReviewResultSchema>;

export const licenceNumberSchema = z
  .object({ number: z.string().meta({ description: 'The full licence number, as the person entered it' }) })
  .meta({ id: 'LicenceNumber' });

type LicenceUser = Pick<User, 'driverLicence' | 'identityVerification'>;

/** The licence for staff: everything but the full number, which is shown only on request. */
export function staffLicenceView(licence: User['driverLicence']): z.infer<typeof staffLicenceSchema> | null {
  if (!licence) return null;
  return {
    class: licence.class,
    country: licence.country,
    numberEnding: licence.numberEnding ?? '',
    ...(licence.version && { version: licence.version }),
    expiry: nzDate(licence.expiry),
    ...(licence.issuedAt && { issuedAt: nzDate(licence.issuedAt) }),
    ...(licence.inEnglish !== undefined && { inEnglish: licence.inEnglish }),
    ...(licence.englishProof && { englishProof: licence.englishProof }),
    status: licence.status,
  };
}

/** What Stripe read from the ID, compared with the account as it is now. */
export function documentComparison(user: LicenceUser): z.infer<typeof documentComparisonSchema> {
  const identity = user.identityVerification;
  return {
    ...(identity?.documentNumberHash &&
      user.driverLicence && {
        licenceNumberMatched: identity.documentNumberHash === user.driverLicence.numberHash,
      }),
    ...(identity?.documentDobMatched !== undefined && { dobMatched: identity.documentDobMatched }),
  };
}

/** Why a licence needs a person: what the identity check did or didn't show. */
function licenceReason(user: LicenceUser): string {
  const identity = user.identityVerification;
  if (!identity || identity.status === 'NONE') {
    return 'No identity check is needed before booking, so nothing has confirmed the licence: check it by hand';
  }
  if (documentComparison(user).licenceNumberMatched === false) {
    return 'The licence on their ID has a different number from this one: check the licence by hand';
  }
  if (identity.documentType === 'driving_license') {
    return 'Their ID was a driver licence, but the check needed a person, so the licence wasn’t confirmed: check it by hand';
  }
  if (identity.documentType) {
    return `Their ID was a ${identity.documentType.replace('_', ' ')}, not the licence: check the licence by hand`;
  }
  return 'Their ID didn’t confirm the licence: check it by hand';
}

type QueueUser = Pick<
  User,
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'dob'
  | 'driverLicence'
  | 'identityVerification'
  | 'riskFlags'
  | 'updatedAt'
> & { _id: mongoose.Types.ObjectId };

/** GET /admin/verifications: identity checks to review first, then licences to check by hand. */
export async function verificationQueue(): Promise<VerificationItem[]> {
  const fields = 'firstName lastName email dob driverLicence identityVerification riskFlags updatedAt';
  const settings = await getPlatformSettings();
  const [identities, licences] = await Promise.all([
    UserModel.find({
      'identityVerification.status': 'PENDING',
      closedAt: mongoose.trusted({ $exists: false }),
    })
      .select(fields)
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean<QueueUser[]>(),
    // Licences only a person can confirm (plan §8.2): after an identity check that didn't confirm them, or with
    // no identity check needed before booking. One whose identity check is in review comes with that check;
    // one waiting for an identity check still to come may be confirmed by it.
    UserModel.find({
      'driverLicence.status': 'PENDING',
      'identityVerification.status': mongoose.trusted({
        $in: settings.verification.identityBeforeFirstBooking ? ['APPROVED'] : ['APPROVED', 'NONE', null],
      }),
      closedAt: mongoose.trusted({ $exists: false }),
    })
      .select(fields)
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean<QueueUser[]>(),
  ]);
  const waiting = await BookingModel.find({
    guestId: mongoose.trusted({ $in: [...identities, ...licences].map((user) => user._id) }),
    status: 'PENDING',
    'verificationReview.status': 'PENDING',
  })
    .select('guestId ref vehicleSnapshot.title requestExpiresAt')
    .lean();

  const item = (user: QueueUser, kind: 'IDENTITY' | 'LICENCE'): VerificationItem => ({
    userId: user._id.toString(),
    kind,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    reason:
      kind === 'IDENTITY'
        ? (user.identityVerification?.reviewReason ?? 'Stripe Identity couldn’t decide')
        : licenceReason(user),
    since: user.updatedAt.toISOString(),
    identity: {
      status: user.identityVerification?.status ?? 'NONE',
      ...(user.identityVerification?.documentType && {
        documentType: user.identityVerification.documentType,
      }),
      ...documentComparison(user),
    },
    licence: staffLicenceView(user.driverLicence),
    ...(user.dob && { dob: nzDate(user.dob) }),
    riskFlags: (user.riskFlags ?? []).filter((flag) => !flag.clearedAt).map((flag) => flag.code),
    waitingBookings: waiting
      .filter((booking) => booking.guestId.equals(user._id))
      .map((booking) => ({
        ref: booking.ref,
        vehicleTitle: booking.vehicleSnapshot.title,
        ...(booking.requestExpiresAt && { expiresAt: booking.requestExpiresAt.toISOString() }),
      })),
  });
  return [
    ...identities.map((user) => item(user, 'IDENTITY')),
    ...licences.map((user) => item(user, 'LICENCE')),
  ];
}

/**
 * GET /admin/users/{id}/licence-number: the full licence number, decrypted for a staff member checking it
 * (plan §14: sensitive fields are encrypted, and each time one is read it's written to the audit log).
 */
export async function revealLicenceNumber(userId: string, staffId: string, ip?: string) {
  const user = mongoose.isValidObjectId(userId)
    ? await UserModel.findById(userId).select('+driverLicence.number').lean()
    : null;
  if (!user?.driverLicence?.number) {
    throw new HttpError(404, 'NOT_FOUND', 'This person has no licence details.');
  }
  const number = decrypt(user.driverLicence.number);
  await recordAudit({
    actorId: staffId,
    action: 'licence.number-viewed',
    entity: 'user',
    entityId: userId,
    ...(ip && { ip }),
  });
  return { number };
}

const accountUrl = () => `${env.FRONTEND_URL.replace(/\/+$/, '')}/account`;

/**
 * POST /admin/users/{id}/licence-review: support checked the licence details by hand. Approved: the bookings
 * that waited for it are confirmed, unless the identity check still waits too. Rejected: they're released,
 * with their card authorisations (plan §8.2). 409 when the licence isn't waiting for a check.
 */
export async function reviewLicence(
  userId: string,
  decision: 'APPROVE' | 'REJECT',
  staffId: string,
  note?: string,
  ip?: string,
  now = new Date(),
): Promise<LicenceReviewResult> {
  const user = mongoose.isValidObjectId(userId)
    ? await UserModel.findById(userId).select('firstName driverLicence')
    : null;
  if (!user?.driverLicence) throw new HttpError(404, 'NOT_FOUND', 'This person has no licence details.');
  const notInReview = () =>
    new HttpError(409, 'NOT_IN_REVIEW', "This person's licence isn't waiting for a check.");
  if (user.driverLicence.status !== 'PENDING') throw notInReview();
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  // Decided once, even when two staff members answer at the same moment.
  const decided = await UserModel.updateOne(
    { _id: user._id, 'driverLicence.status': 'PENDING' },
    { $set: { 'driverLicence.status': status, 'driverLicence.reviewedBy': staffId } },
  );
  if (decided.modifiedCount === 0) throw notInReview();
  await recordAudit({
    actorId: staffId,
    action: `licence.${status.toLowerCase()}`,
    entity: 'user',
    entityId: user.id,
    after: { status, ...(note && { note }) },
    ...(ip && { ip }),
  });
  const outcome: VerificationOutcome = await resolveVerificationReview(user.id, decision, staffId, now);
  const stillWaiting = outcome.stillInReview ?? [];

  if (decision === 'APPROVE') {
    await notify({
      userId: user._id,
      type: 'LICENCE_APPROVED',
      title: 'Your driver licence is approved',
      body:
        outcome.confirmed.length > 0
          ? `Booking ${outcome.confirmed.join(', ')} is confirmed.`
          : stillWaiting.length > 0
            ? `Booking ${stillWaiting.join(', ')} waits for our check of your identity.`
            : 'You’re all set to book.',
      link: '/account',
      email: {
        template: 'tripNotice',
        props: {
          firstName: user.firstName,
          heading: 'Your driver licence is approved',
          paragraphs: [
            'Our team has checked the licence details on your account, and they’re approved.',
            ...(outcome.confirmed.length > 0
              ? [`Your booking ${outcome.confirmed.join(', ')} is confirmed.`]
              : []),
            ...(outcome.waitingForHost.length > 0
              ? [`Your request ${outcome.waitingForHost.join(', ')} is with the host to accept.`]
              : []),
            ...(stillWaiting.length > 0
              ? [
                  `Your booking ${stillWaiting.join(', ')} is still held for you while we finish your identity check. Your card isn’t charged until it’s approved.`,
                ]
              : []),
          ],
          buttonLabel: 'Your account',
          url: accountUrl(),
        },
      },
      dedupeKey: `LICENCE_APPROVED:${user.id}:${now.getTime()}`,
    });
  } else {
    await notify({
      userId: user._id,
      type: 'LICENCE_REJECTED',
      title: 'We couldn’t accept your licence',
      body: note ?? 'Please check your licence details, or contact support.',
      link: '/account',
      email: {
        template: 'tripNotice',
        props: {
          firstName: user.firstName,
          heading: 'We couldn’t accept your driver licence',
          paragraphs: [
            'Our team checked the licence details on your account and couldn’t accept them, so you can’t book a car for now.',
            ...(note ? [`Their note: ${note}`] : []),
            ...(outcome.released.length > 0
              ? [
                  `Booking ${outcome.released.join(', ')} was released, and your card authorisation with it: nothing was charged.`,
                ]
              : []),
            'If something was entered wrongly, update it from your account, or reply to this email.',
          ],
          buttonLabel: 'Check your details',
          url: accountUrl(),
        },
      },
      dedupeKey: `LICENCE_REJECTED:${user.id}:${now.getTime()}`,
    });
  }
  return { licenceStatus: status, ...outcome };
}
