import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';
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
 * proof for an overseas licence that isn't in English. Support staff check licences by hand until the
 * identity check arrives (plan §16, item 15).
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

export type EligibilityProblem = CheckoutReadiness['problems'][number];

type EligibilityUser = Pick<User, 'phoneVerifiedAt' | 'dob' | 'driverLicence'>;

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
    identityStatus: user.identityVerification?.status ?? 'NONE',
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
  user.dob = dob;
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
    // Changed details are checked again; unchanged ones keep their review.
    status: unchanged && user.driverLicence ? user.driverLicence.status : 'PENDING',
  };

  const elsewhere = await UserModel.exists({
    'driverLicence.numberHash': numberHash,
    _id: mongoose.trusted({ $ne: user._id }),
  });
  if (elsewhere && !user.riskFlags.some((flag) => flag.code === 'DUPLICATE_LICENCE' && !flag.clearedAt)) {
    user.riskFlags.push({
      code: 'DUPLICATE_LICENCE',
      detail: 'The same licence number is on another account',
      createdAt: new Date(),
    });
  }
  await user.save();
  await recordAudit({ actorId: user._id, action: 'licence.saved', entity: 'user', entityId: user.id, ip });
  return checkoutReadiness(userId);
}
