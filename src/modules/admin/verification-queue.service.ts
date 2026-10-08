import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { nzDate } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { UserModel, type User } from '../users/user.model.js';

/*
 * The support team's verification queue (spec §22; plan §9 Days 19–20): identity checks Stripe couldn't
 * decide, or whose document doesn't match what the person entered, then driver licences no document has
 * confirmed. Approving an identity check confirms the bookings that waited for it.
 */

export const verificationItemSchema = z
  .object({
    userId: z.string(),
    kind: z.enum(['IDENTITY', 'LICENCE']),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    reason: z.string(),
    since: z.iso.datetime(),
    identity: z.object({ status: z.string(), documentType: z.string().optional() }),
    licence: z
      .object({
        class: z.string(),
        country: z.string(),
        numberEnding: z.string(),
        version: z.string().optional(),
        expiry: z.string(),
        issuedAt: z.string().optional(),
        englishProof: z.string().optional(),
        status: z.string(),
      })
      .nullable(),
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
  const [identities, licences] = await Promise.all([
    UserModel.find({
      'identityVerification.status': 'PENDING',
      closedAt: mongoose.trusted({ $exists: false }),
    })
      .select(fields)
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean<QueueUser[]>(),
    UserModel.find({
      'driverLicence.status': 'PENDING',
      'identityVerification.status': 'APPROVED',
      closedAt: mongoose.trusted({ $exists: false }),
    })
      .select(fields)
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean<QueueUser[]>(),
  ]);
  const waiting = await BookingModel.find({
    guestId: mongoose.trusted({ $in: identities.map((user) => user._id) }),
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
        : `Their ID was a ${user.identityVerification?.documentType?.replace('_', ' ') ?? 'document'}, not the licence: check the licence by hand`,
    since: user.updatedAt.toISOString(),
    identity: {
      status: user.identityVerification?.status ?? 'NONE',
      ...(user.identityVerification?.documentType && {
        documentType: user.identityVerification.documentType,
      }),
    },
    licence: user.driverLicence
      ? {
          class: user.driverLicence.class,
          country: user.driverLicence.country,
          numberEnding: user.driverLicence.numberEnding ?? '',
          ...(user.driverLicence.version && { version: user.driverLicence.version }),
          expiry: nzDate(user.driverLicence.expiry),
          ...(user.driverLicence.issuedAt && { issuedAt: nzDate(user.driverLicence.issuedAt) }),
          ...(user.driverLicence.englishProof && { englishProof: user.driverLicence.englishProof }),
          status: user.driverLicence.status,
        }
      : null,
    ...(user.dob && { dob: nzDate(user.dob) }),
    riskFlags: user.riskFlags.filter((flag) => !flag.clearedAt).map((flag) => flag.code),
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

/** POST /admin/users/{id}/licence-review: support checked the licence details by hand. */
export async function reviewLicence(
  userId: string,
  decision: 'APPROVE' | 'REJECT',
  staffId: string,
  note?: string,
  ip?: string,
) {
  const user = mongoose.isValidObjectId(userId)
    ? await UserModel.findById(userId).select('firstName driverLicence')
    : null;
  if (!user?.driverLicence) throw new HttpError(404, 'NOT_FOUND', 'This person has no licence details.');
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { 'driverLicence.status': status, 'driverLicence.reviewedBy': staffId } },
  );
  await recordAudit({
    actorId: staffId,
    action: `licence.${status.toLowerCase()}`,
    entity: 'user',
    entityId: user.id,
    after: { status, ...(note && { note }) },
    ...(ip && { ip }),
  });
  if (decision === 'REJECT') {
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
            'If something was entered wrongly, update it from your account, or reply to this email.',
          ],
          buttonLabel: 'Check your details',
          url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/account`,
        },
      },
      dedupeKey: `LICENCE_REJECTED:${user.id}:${Date.now()}`,
    });
  }
  return { licenceStatus: status };
}
