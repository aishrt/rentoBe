import { createHmac } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import { env } from '../../env.js';
import { countryCode } from '../../lib/countries.js';
import { encrypt } from '../../lib/encryption.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { fromNzWallClock, nzDate, nzDayEnd } from '../../lib/nz-time.js';
import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import type { Booking } from '../bookings/booking.model.js';
import type { CheckoutReadiness, DriverLicenceInput } from './driver-licence.schemas.js';
import { UserModel, type User } from './user.model.js';

/*
 * Driver licence details and the eligibility rules in settings (plan §3, Validation rules: booking):
 * age, accepted licence classes, years licensed, a licence valid until the trip ends, and English
 * proof for an overseas licence that isn't in English. A driver licence used as the ID in the identity check
 * confirms the licence; otherwise support staff check it by hand, and a booking made meanwhile becomes a
 * request (plan §8.2). No NZ licence-check service is connected (plan §16, item 15). Dates are NZ calendar
 * dates (plan §3: times in Pacific/Auckland).
 */

/** Midnight at the start of an NZ day given as 2026-10-07: how a licence's dates and a birthday are kept. */
const dayStart = (value: string) => {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return fromNzWallClock(year, month, day);
};

/** A licence is valid through the whole of its expiry day in NZ, as a car's documents are. */
export const licenceValidUntil = (expiry: Date) => nzDayEnd(nzDate(expiry));

/** Whole years from `from` to `on`, counted on NZ calendars: a birthday counts from the start of its day. */
function yearsOn(from: Date, on: Date): number {
  const [fromYear, fromMonth, fromDay] = nzDate(from).split('-').map(Number) as [number, number, number];
  const [year, month, day] = nzDate(on).split('-').map(Number) as [number, number, number];
  const beforeAnniversary = month < fromMonth || (month === fromMonth && day < fromDay);
  return year - fromYear - (beforeAnniversary ? 1 : 0);
}

/** The licence's country as an ISO code ("AU"); a licence saved before codes were kept is read the same way. */
export const licenceCountryCode = (licence: Pick<NonNullable<User['driverLicence']>, 'country' | 'class'>) =>
  countryCode(licence.country) ?? (licence.class === 'OVERSEAS' ? undefined : 'NZ');

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

/**
 * What stops this person driving a trip that ends at `tripEnd` (without one, today). Age and years licensed
 * count to the trip's start (without one, today), on NZ calendar dates.
 */
export function eligibilityProblems(
  user: EligibilityUser,
  settings: PlatformSettings,
  tripEnd: Date = new Date(),
  now = new Date(),
  tripStart: Date = now,
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
  if (yearsOn(user.dob, tripStart) < rules.minAge) {
    problems.push({ code: 'TOO_YOUNG', message: `Drivers need to be at least ${rules.minAge}.` });
  }
  if (!rules.acceptedLicenceClasses.includes(licence.class)) {
    problems.push({
      code: 'CLASS_NOT_ACCEPTED',
      message: 'Guests need a full NZ licence, or a full overseas licence.',
    });
  }
  if (licence.issuedAt && yearsOn(licence.issuedAt, tripStart) < rules.minYearsLicensed) {
    problems.push({
      code: 'NOT_LICENSED_LONG_ENOUGH',
      message: `Drivers need to have held their licence for at least ${rules.minYearsLicensed} ${rules.minYearsLicensed === 1 ? 'year' : 'years'}.`,
    });
  }
  if (licenceValidUntil(licence.expiry) < tripEnd) {
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

/** The licence rules a booked trip is held to (plan §3), checked again when the licence changes. */
const LICENCE_CODES: readonly EligibilityProblem['code'][] = [
  'LICENCE_REQUIRED',
  'LICENCE_REJECTED',
  'TOO_YOUNG',
  'CLASS_NOT_ACCEPTED',
  'NOT_LICENSED_LONG_ENOUGH',
  'LICENCE_EXPIRES',
  'ENGLISH_PROOF_REQUIRED',
];

/** What in the Guest's licence now stops a booked trip, as booking it would have been refused. */
export const licenceProblemsForTrip = (
  user: EligibilityUser,
  settings: PlatformSettings,
  trip: Pick<Booking, 'startAt' | 'endAt'>,
  now = new Date(),
) =>
  eligibilityProblems(user, settings, trip.endAt, now, trip.startAt).filter((problem) =>
    LICENCE_CODES.includes(problem.code),
  );

/**
 * Rules whose bar is in the settings and that the licence met when booked: raising the minimum age or years
 * licensed, or asking for English proof, doesn't stop a trip already booked, as bookings keep the terms they
 * were made with (platform-settings.service.ts).
 */
const SETTINGS_RULE_CODES: readonly EligibilityProblem['code'][] = [
  'TOO_YOUNG',
  'NOT_LICENSED_LONG_ENOUGH',
  'ENGLISH_PROOF_REQUIRED',
];

/**
 * What in the Guest's licence stops a confirmed trip starting (licenceProblemsForTrip): the rules the settings
 * set count only when the Guest changed their licence details after booking, so details they changed then are
 * held to the rules in force. A turned-down licence, one that runs out before the trip ends or a class the
 * rules don't accept always count.
 */
export function licenceProblemsAtCheckIn(
  user: EligibilityUser,
  settings: PlatformSettings,
  trip: Pick<Booking, 'startAt' | 'endAt' | 'createdAt'>,
  now = new Date(),
) {
  const changedAt = user.driverLicence?.detailsChangedAt;
  const changedSinceBooking = Boolean(changedAt && trip.createdAt && changedAt > trip.createdAt);
  return licenceProblemsForTrip(user, settings, trip, now).filter(
    (problem) => changedSinceBooking || !SETTINGS_RULE_CODES.includes(problem.code),
  );
}

/**
 * What stops a trip starting, and why, as the Guest and Host read it: each licence rule a booked trip is held
 * to (LICENCE_CODES), so check-in refuses what support are told it refuses. No licence at all can't happen on
 * a booked trip (booking needs one, and it stays while bookings do), so it isn't asked for here.
 */
const CHECK_IN_REASONS: Partial<Record<EligibilityProblem['code'], string>> = {
  LICENCE_REJECTED: 'our team couldn’t accept it',
  LICENCE_EXPIRES: 'it expires before the trip ends',
  CLASS_NOT_ACCEPTED: 'its licence class isn’t accepted for trips',
  TOO_YOUNG: 'the driver is under our minimum age on the day the trip starts',
  NOT_LICENSED_LONG_ENOUGH: 'it won’t have been held long enough by the day the trip starts',
  ENGLISH_PROOF_REQUIRED:
    'it isn’t in English, and no International Driving Permit or approved translation is on the account',
};

/**
 * Check-in (plan §3: the Guest holds a licence valid until the trip ends): 409 LICENCE_NOT_ELIGIBLE when the
 * Guest's licence breaks a licence rule for the trip (turned down, runs out before the trip ends, a class the
 * rules don't accept; too young, not held long enough, or no English proof when the details changed after
 * booking: licenceProblemsAtCheckIn), or while the licence waits for support's check (plan §8.2: confirmed
 * once support approves it). Any licence still PENDING counts, in support's queue or not: one that isn't (its
 * identity check turned down since, say) hasn't been checked by anyone.
 */
export async function assertLicenceForTrip(
  booking: Pick<Booking, 'guestId' | 'startAt' | 'endAt' | 'createdAt'>,
  viewer: 'GUEST' | 'HOST',
  now = new Date(),
) {
  const [guest, settings] = await Promise.all([
    UserModel.findById(booking.guestId)
      .select('phoneVerifiedAt dob driverLicence identityVerification')
      .lean(),
    getPlatformSettings(),
  ]);
  if (!guest) return;
  const problem = licenceProblemsAtCheckIn(guest, settings, booking, now).find(
    (candidate) => CHECK_IN_REASONS[candidate.code],
  );
  if (!problem) {
    // Details changed since booking (or a turned-down licence sent back to support) wait for their decision.
    if (guest.driverLicence?.status !== 'PENDING') return;
    throw new HttpError(
      409,
      'LICENCE_NOT_ELIGIBLE',
      viewer === 'GUEST'
        ? 'Your licence details are still being checked by our team, so the trip can’t start yet. We’ll email you as soon as they’re approved, usually within a few hours. If your trip is about to start, contact support.'
        : 'The guest’s driver licence details are still being checked by our team, so the trip can’t start yet. Contact support and we’ll help.',
    );
  }
  const reason = CHECK_IN_REASONS[problem.code]!;
  throw new HttpError(
    409,
    'LICENCE_NOT_ELIGIBLE',
    viewer === 'GUEST'
      ? `Your driver licence can’t be used for this trip: ${reason}. Update your licence details in your account, or contact support.`
      : `The guest’s driver licence can’t be used for this trip (${reason}), so the trip can’t start. Contact support and we’ll help.`,
  );
}

/** GET /me/checkout: what checkout's verification step still needs from this person. */
export async function checkoutReadiness(
  userId: string,
  tripEnd?: Date,
  tripStart?: Date,
): Promise<CheckoutReadiness> {
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
          country: licenceCountryCode(licence) ?? licence.country,
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
    problems: eligibilityProblems(user, settings, tripEnd, new Date(), tripStart),
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
  // Still valid on its expiry day.
  if (licenceValidUntil(expiry) <= new Date()) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      expiry: 'This licence has expired',
    });
  }
  if (issuedAt > new Date() || dob > issuedAt) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      issuedAt: 'Check the issue date',
    });
  }
  // The country is kept as its ISO code ("AU"), to compare with a card's (plan §14); a name is read as one.
  const country = input.class === 'OVERSEAS' ? countryCode(input.country) : 'NZ';
  if (!country || (input.class === 'OVERSEAS' && country === 'NZ')) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      country: 'Choose the country that issued your licence',
    });
  }

  const numberHash = licenceNumberHash(input.number);
  const identity = user.identityVerification;
  const dobChanged = user.dob?.getTime() !== dob.getTime();
  // Once a passed identity check has read a date of birth, a different one is corrected through a privacy
  // request, as the name is (plan §11): it's checked against the ID there, not changed here.
  if (
    dobChanged &&
    identity?.status === 'APPROVED' &&
    identity.documentDobHash &&
    identity.documentDobHash !== documentDobHash(nzDate(dob))
  ) {
    throw new HttpError(409, 'DOB_LOCKED', 'Your date of birth has to match your verified ID.', {
      dob: 'This has to match your verified ID. If it’s wrong, ask us to correct it in Settings, under Your privacy, and we’ll check it against your ID.',
    });
  }
  const previous = user.driverLicence;
  const next = {
    numberHash,
    class: input.class,
    country,
    version: input.class !== 'OVERSEAS' ? input.version : undefined,
    inEnglish: input.class === 'OVERSEAS' ? !input.notInEnglish : undefined,
    englishProof: input.englishProof || undefined,
  };
  // The review stands only for exactly the details it reviewed: any change to the licence or the date of
  // birth (each can decide whether the person may drive, plan §3) is checked again.
  const unchanged = Boolean(
    previous &&
    !dobChanged &&
    previous.numberHash === next.numberHash &&
    previous.class === next.class &&
    // A licence saved before countries were kept as codes ("New Zealand") is the same as its code.
    licenceCountryCode(previous) === next.country &&
    (previous.version || undefined) === next.version &&
    (previous.inEnglish ?? undefined) === next.inEnglish &&
    (previous.englishProof || undefined) === next.englishProof &&
    previous.issuedAt?.getTime() === issuedAt.getTime() &&
    previous.expiry.getTime() === expiry.getTime(),
  );
  // When the details last changed (or were first entered): a trip booked before then is held to the rules in
  // force now at check-in (licenceProblemsAtCheckIn).
  const detailsChangedAt = unchanged && previous ? previous.detailsChangedAt : new Date();
  // The date of birth is compared with the one the ID showed, when the check read one.
  if (identity?.documentDobHash) {
    identity.documentDobMatched = identity.documentDobHash === documentDobHash(nzDate(dob));
  } else if (identity && dobChanged) {
    // A new date of birth wasn't the one compared with the ID.
    identity.documentDobMatched = undefined;
  }
  user.dob = dob;
  // A licence entered after a passed ID check that read a driving licence: the same number and date of birth
  // confirm it, as they would have if it had been entered first (plan §9, Days 19–20); a difference goes to
  // support.
  // A licence number kept from an earlier check support turned down (allowVerificationRetry) has no document
  // type with it, so it confirms nothing.
  const matchedById =
    identity?.status === 'APPROVED' &&
    identity.documentType === 'driving_license' &&
    identity.documentNumberHash === numberHash &&
    identity.documentDobMatched === true;
  user.driverLicence = {
    number: encrypt(input.number),
    numberHash,
    numberEnding: input.number.slice(-3),
    ...(next.version !== undefined && { version: next.version }),
    ...(next.inEnglish !== undefined && { inEnglish: next.inEnglish }),
    country: next.country,
    class: next.class,
    ...(next.englishProof && { englishProof: next.englishProof }),
    issuedAt,
    expiry,
    ...(detailsChangedAt && { detailsChangedAt }),
    // Unchanged details keep their review. Changed ones are checked again by support, unless the ID
    // confirmed them; a licence support turned down goes back to them once it's corrected.
    status:
      unchanged && previous
        ? previous.status
        : matchedById && previous?.status !== 'REJECTED'
          ? 'APPROVED'
          : 'PENDING',
  };

  await user.save();
  await flagDuplicateLicence(user._id, numberHash);
  await recordAudit({ actorId: user._id, action: 'licence.saved', entity: 'user', entityId: user.id, ip });
  return checkoutReadiness(userId);
}
