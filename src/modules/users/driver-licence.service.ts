import { createHmac } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import { env } from '../../env.js';
import { encrypt } from '../../lib/encryption.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { fromNzWallClock, nzDate } from '../../lib/nz-time.js';
import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CheckoutReadiness, DriverLicenceInput } from './driver-licence.schemas.js';
import { UserModel, type User } from './user.model.js';

/*
 * Driver licence details and the eligibility rules in settings (plan §3, Validation rules: booking):
 * age, accepted licence classes, years licensed, a licence valid until the trip ends, and English
 * proof for an overseas licence that isn't in English. A driver licence used as the ID in the identity check
 * confirms the licence; otherwise support staff check it by hand, and a booking made meanwhile becomes a
 * request (plan §8.2). No NZ licence-check service is connected (plan §16, item 15).
 */

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

const dayStart = (value: string) => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return fromNzWallClock(year, month, day);
};

/** A keyed hash of the licence number, to find the same licence on another account (plan §3). */
export function licenceNumberHash(number: string): string {
  const key = createHmac('sha256', env.ENCRYPTION_KEY).update('licence-number').digest();
  return createHmac('sha256', key).update(number.replace(/\s+/g, '').toUpperCase()).digest('hex');
}

/** A keyed hash of a date of birth (2026-10-09) read from an ID, kept instead of the date itself. */
export function documentDobHash(date: string): string {
  const key = createHmac('sha256', env.ENCRYPTION_KEY).update('document-dob').digest();
  return createHmac('sha256', key).update(date).digest('hex');
}

export type EligibilityProblem = CheckoutReadiness['problems'][number];

/**
 * The same licence on more than one account raises a risk flag on each of them (plan §3, same person,
 * several accounts), rather than an error, so support can merge a genuine re-registration. `numberHash` is the
 * licence entered, or one an ID check read.
 */
export async function flagDuplicateLicence(userId: Types.ObjectId, numberHash: string, now = new Date()) {
  const others = await UserModel.find({
    _id: mongoose.trusted({ $ne: userId }),
    $or: [
      { 'driverLicence.numberHash': numberHash },
      { 'identityVerification.documentNumberHash': numberHash },
    ],
  })
    .select('_id')
    .lean();
  if (others.length === 0) return;
  for (const id of [userId, ...others.map((other) => other._id)]) {
    await UserModel.updateOne(
      {
        _id: id,
        riskFlags: mongoose.trusted({
          $not: { $elemMatch: { code: 'DUPLICATE_LICENCE', clearedAt: { $exists: false } } },
        }),
      },
      {
        $push: {
          riskFlags: {
            code: 'DUPLICATE_LICENCE',
            detail: 'The same licence number is on another account',
            createdAt: now,
          },
        },
      },
    );
  }
}

type EligibilityUser = Pick<User, 'phoneVerifiedAt' | 'dob' | 'driverLicence' | 'identityVerification'>;

/** Stripe is still checking the person's ID and selfie (plan §8.2: checkout waits for the result). */
export const identityProcessing = (user: Pick<User, 'identityVerification'>) =>
  user.identityVerification?.status === 'NONE' && user.identityVerification.sessionStatus === 'processing';

type ReviewUser = Pick<User, 'identityVerification' | 'driverLicence'>;

/**
 * A licence only support staff can confirm now (plan §8.2): its details are new or changed, and no identity
 * check is still to come that would read them from a driver licence. With the identity check required and
 * not done yet, the person can't book anyway, and the check may confirm the licence itself, so a person
 * isn't asked to look. A rejected identity stops booking whatever the licence says.
 */
export function licenceAwaitingReview(user: ReviewUser, settings: Pick<PlatformSettings, 'verification'>) {
  if (user.driverLicence?.status !== 'PENDING') return false;
  const identity = user.identityVerification?.status ?? 'NONE';
  if (identity === 'NONE') return !settings.verification.identityBeforeFirstBooking;
  return identity !== 'REJECTED';
}

/**
 * Whether this person's identity check or licence is waiting for support staff (plan §8.2). They can still
 * book: the card is authorised, and the booking is confirmed once both are approved.
 */
export const verificationInReview = (user: ReviewUser, settings: Pick<PlatformSettings, 'verification'>) =>
  user.identityVerification?.status === 'PENDING' || licenceAwaitingReview(user, settings);

/** What stops this person driving a trip that ends at `tripEnd` (without one, today). */
export function eligibilityProblems(
  user: EligibilityUser,
  settings: PlatformSettings,
  tripEnd: Date = new Date(),
  now = new Date(),
): EligibilityProblem[] {
  const problems: EligibilityProblem[] = [];
  const rules = settings.eligibility;
  if (settings.verification.phoneAtCheckout && !user.phoneVerifiedAt) {
    problems.push({ code: 'PHONE_REQUIRED', message: 'Verify your mobile number.' });
  }
  const identity = user.identityVerification?.status ?? 'NONE';
  if (identity === 'REJECTED') {
    problems.push({
      code: 'IDENTITY_REJECTED',
      message: "We couldn't verify your identity. Please contact support.",
    });
  } else if (settings.verification.identityBeforeFirstBooking && identity === 'NONE') {
    // A check in review (PENDING) can still book: the booking waits for support (plan §8.2).
    problems.push(
      identityProcessing(user)
        ? {
            code: 'IDENTITY_PROCESSING',
            message: 'We’re checking your ID. This usually takes a minute or two.',
          }
        : {
            code: 'IDENTITY_REQUIRED',
            message: 'Verify your identity with a photo of your ID and a selfie.',
          },
    );
  }
  const licence = user.driverLicence;
  if (!licence || !user.dob) {
    problems.push({ code: 'LICENCE_REQUIRED', message: 'Add your driver licence details.' });
    return problems;
  }
  if (licence.status === 'REJECTED') {
    problems.push({
      code: 'LICENCE_REJECTED',
      message: "We couldn't accept your licence. Please contact support.",
    });
  }
  if ((now.getTime() - user.dob.getTime()) / YEAR_MS < rules.minAge) {
    problems.push({ code: 'TOO_YOUNG', message: `Drivers need to be at least ${rules.minAge}.` });
  }
  if (!rules.acceptedLicenceClasses.includes(licence.class)) {
    problems.push({
      code: 'CLASS_NOT_ACCEPTED',
      message: 'Guests need a full NZ licence, or a full overseas licence.',
    });
  }
  if (licence.issuedAt && (now.getTime() - licence.issuedAt.getTime()) / YEAR_MS < rules.minYearsLicensed) {
    problems.push({
      code: 'NOT_LICENSED_LONG_ENOUGH',
      message: `Drivers need to have held their licence for at least ${rules.minYearsLicensed} ${rules.minYearsLicensed === 1 ? 'year' : 'years'}.`,
    });
  }
  if (licence.expiry < tripEnd) {
    problems.push({
      code: 'LICENCE_EXPIRES',
      message: 'Your licence needs to be valid until the trip ends.',
    });
  }
  if (
    rules.overseasNeedsEnglishProof &&
    licence.class === 'OVERSEAS' &&
    licence.inEnglish === false &&
    !licence.englishProof
  ) {
    problems.push({
      code: 'ENGLISH_PROOF_REQUIRED',
      message: 'Bring an International Driving Permit or an approved translation of your licence.',
    });
  }
  return problems;
}

/** GET /me/checkout: what checkout's verification step still needs from this person. */
export async function checkoutReadiness(userId: string, tripEnd?: Date): Promise<CheckoutReadiness> {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  const settings = await getPlatformSettings();
  const licence = user.driverLicence;
  return {
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    ...(user.phone && { phone: user.phone }),
    licence: licence
      ? {
          class: licence.class,
          country: licence.country,
          numberEnding: licence.numberEnding ?? '',
          expiry: nzDate(licence.expiry),
          status: licence.status,
          ...(licence.englishProof && { englishProof: licence.englishProof }),
        }
      : null,
    hasDateOfBirth: Boolean(user.dob),
    licenceInReview: licenceAwaitingReview(user, settings),
    identityStatus: user.identityVerification?.status ?? 'NONE',
    identityProcessing: identityProcessing(user),
    ...(user.identityVerification?.lastError && { identityError: user.identityVerification.lastError }),
    problems: eligibilityProblems(user, settings, tripEnd),
  };
}

/**
 * PUT /me/driver-licence. Saves the details for support staff to check. The same licence on another
 * account raises a risk flag for admins rather than an error, so a genuine re-registration can be
 * merged (plan §3, Key rules).
 */
export async function saveDriverLicence(
  userId: string,
  input: DriverLicenceInput,
  ip?: string,
): Promise<CheckoutReadiness> {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  const expiry = dayStart(input.expiry);
  const issuedAt = dayStart(input.issuedAt);
  const dob = dayStart(input.dob);
  if ([expiry, issuedAt, dob].some((value) => Number.isNaN(value.getTime()))) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', { expiry: 'Enter real dates' });
  }
  if (expiry <= new Date()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      expiry: 'This licence has expired',
    });
  }
  if (issuedAt > new Date() || dob > issuedAt) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      issuedAt: 'Check the issue date',
    });
  }

  const numberHash = licenceNumberHash(input.number);
  const unchanged = user.driverLicence?.numberHash === numberHash;
  const identity = user.identityVerification;
  // The date of birth is compared with the one the ID showed, when the check read one.
  if (identity?.documentDobHash) {
    identity.documentDobMatched = identity.documentDobHash === documentDobHash(nzDate(dob));
  } else if (identity && user.dob?.getTime() !== dob.getTime()) {
    // A new date of birth wasn't the one compared with the ID.
    identity.documentDobMatched = undefined;
  }
  user.dob = dob;
  // A licence entered after a passed ID check that read a driving licence: the same number and date of birth
  // confirm it, as they would have if it had been entered first (plan §9, Days 19–20); a difference goes to
  // support.
  const matchedById =
    identity?.status === 'APPROVED' &&
    identity.documentNumberHash === numberHash &&
    identity.documentDobMatched === true;
  user.driverLicence = {
    number: encrypt(input.number),
    numberHash,
    numberEnding: input.number.slice(-3),
    ...(input.class !== 'OVERSEAS' && { version: input.version }),
    ...(input.class === 'OVERSEAS' && { inEnglish: !input.notInEnglish }),
    country: input.class === 'OVERSEAS' ? input.country : 'New Zealand',
    class: input.class,
    ...(input.englishProof && { englishProof: input.englishProof }),
    issuedAt,
    expiry,
    // Changed details are checked again (unless the ID confirmed them); unchanged ones keep their review.
    status:
      unchanged && user.driverLicence ? user.driverLicence.status : matchedById ? 'APPROVED' : 'PENDING',
  };

  await user.save();
  await flagDuplicateLicence(user._id, numberHash);
  await recordAudit({ actorId: user._id, action: 'licence.saved', entity: 'user', entityId: user.id, ip });
  return checkoutReadiness(userId);
}
