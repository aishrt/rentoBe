import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { cents, ratingSchema, type Rating } from '../../lib/model-fields.js';

export const ROLES = ['GUEST', 'HOST', 'ADMIN', 'SUPPORT'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can open the admin portal (plan §6.2). */
export const STAFF_ROLES = ['ADMIN', 'SUPPORT'] as const satisfies readonly Role[];

/**
 * Extra rights a support staff member can be given (plan §6.2). Admins have all of them.
 * REFUNDS: issue refunds from the admin portal.
 */
export const PERMISSIONS = ['REFUNDS'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** The legal documents a user accepts (plan §6.1): Terms and Privacy at sign-up, the others later. */
export const AGREEMENT_TYPES = ['TERMS', 'PRIVACY', 'GUEST', 'HOST'] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

/** One acceptance of one version of a legal document, kept as a legal record (plan §14). */
export interface Agreement {
  type: AgreementType;
  version: string;
  acceptedAt: Date;
  ip?: string;
}

/** How many authenticator apps a staff member can have: their phone, and a backup. */
export const MAX_MFA_DEVICES = 2;

/** One authenticator app a staff member signs in with. */
export interface MfaDevice {
  _id: Types.ObjectId;
  /** The staff member's name for it, e.g. "Work phone". */
  name: string;
  /** Encrypted (src/lib/encryption.ts). */
  secret: string;
  addedAt: Date;
  lastUsedAt?: Date;
  /** The last code's time step, so the same code can't be used twice (replay). */
  lastTimeStep?: number;
}

/**
 * Staff two-factor sign-in with an authenticator app (plan §6.1), optional and turned on or off by
 * each staff member in the staff portal's settings. The secrets are encrypted and never leave the
 * database except to check a code.
 */
export interface StaffMfa {
  devices: MfaDevice[];
  /** Set during setup, until the first code proves the app has it. */
  pendingSecret?: string;
  /** When the first device was added. Set while there is at least one device. */
  enabledAt?: Date;
  /**
   * Before a second device was possible, the one app's secret and time step were kept here. They
   * become the first device the next time they're needed (mfa.service.ts); no migration needed.
   */
  secret?: string;
  lastTimeStep?: number;
}

export const VERIFICATION_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** An earlier identity check the person started again: its images go 90 days after it began (plan §14). */
export interface EarlierIdentitySession {
  /** Stripe Identity's VerificationSession id. */
  providerRef: string;
  startedAt: Date;
  redactedAt?: Date;
}

/** Identity check for Guests and Hosts (plan §9, Days 19–20). ID images stay with the provider. */
export interface IdentityVerification {
  /** NONE until it passes; PENDING while support reviews it by hand (plan §8.2). */
  status: VerificationStatus;
  provider?: string;
  /** Stripe Identity's VerificationSession id. */
  providerRef?: string;
  /** Stripe's own state of the session: requires_input, processing, verified or canceled. */
  sessionStatus?: string;
  /** Why the last attempt didn't pass, to show the person so they can try again. */
  lastError?: string;
  /** Why it needs a person to look at it, for support staff. */
  reviewReason?: string;
  /** The document checked: driving_license, passport or id_card. */
  documentType?: string;
  /**
   * A keyed hash of the licence number Stripe read from a driver licence used as the ID, so staff can see
   * whether it matches the licence on the account, even after the person changes it.
   */
  documentNumberHash?: string;
  /** Whether the date of birth Stripe read from the ID matched the account's when it was checked. */
  documentDobMatched?: boolean;
  /**
   * A keyed hash of that date of birth, so details entered after the check (a licence saved once the ID check
   * has passed) are compared with what the ID said.
   */
  documentDobHash?: string;
  /** When the latest check began: a check that never passes is redacted this long after it (plan §14). */
  startedAt?: Date;
  verifiedAt?: Date;
  reviewedBy?: Types.ObjectId;
  /** When Stripe deleted the ID images, keeping only the result (plan §14: 90 days). */
  redactedAt?: Date;
  /** Checks started before this one, each redacted 90 days after it began. */
  earlierSessions?: EarlierIdentitySession[];
}

export const LICENCE_CLASSES = ['NZ_FULL', 'NZ_RESTRICTED', 'NZ_LEARNER', 'OVERSEAS'] as const;
export type LicenceClass = (typeof LICENCE_CLASSES)[number];

/** For an overseas licence that isn't in English (plan §3). */
export const ENGLISH_PROOFS = ['IDP', 'APPROVED_TRANSLATION'] as const;

export interface DriverLicence {
  /** Encrypted (src/lib/encryption.ts). */
  number: string;
  /** Keyed HMAC of the number, to find the same licence on another account (plan §3, Key rules). */
  numberHash: string;
  /** The last 3 characters, so the person can recognise the licence without the full number. */
  numberEnding?: string;
  version?: string;
  country: string;
  class: LicenceClass;
  /** False for an overseas licence that isn't in English, which then needs English proof. */
  inEnglish?: boolean;
  englishProof?: (typeof ENGLISH_PROOFS)[number];
  issuedAt?: Date;
  expiry: Date;
  status: Exclude<VerificationStatus, 'NONE'>;
  reviewedBy?: Types.ObjectId;
}

export const HOST_STATUSES = ['APPLIED', 'APPROVED', 'REJECTED', 'SUSPENDED'] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

export interface HostProfile {
  status: HostStatus;
  appliedAt: Date;
  reviewedBy?: Types.ObjectId;
  reviewNotes?: string;
  stripeAccountId?: string;
  /** Times Stripe refused to make the Host's account: each try after a refusal uses a new idempotency key. */
  connectRefusals?: number;
  payoutsEnabled: boolean;
  /** What Stripe still needs from the Host before payouts can be sent (plan §8.1, item 20). */
  payoutRequirements?: string[];
  /** Business days Stripe takes to pay the Host's bank after a transfer, from their account. */
  payoutDelayDays?: number;
  bio?: string;
  /** Share of booking requests answered, 0–100. */
  responseRate?: number;
  tripCount: number;
  rating: Rating;
  /** Host cancellation fees not yet deducted from a payout. */
  feesOwedCents: number;
  /**
   * Host-funded refunds made after the booking's payout was sent, to come off the next payout (plan §8.1,
   * item 15). Hosts from before it have none stored: read with `?? []`.
   */
  refundsOwed?: RefundOwed[];
  gstRegistered: boolean;
  gstNumber?: string;
}

/** A Host-funded refund the Host still owes, or the part of it not yet taken off a payout. */
export interface RefundOwed {
  bookingId: Types.ObjectId;
  stripeRefundId: string;
  amountCents: number;
  createdAt: Date;
}

/** Choices for non-essential messages (plan §7). Booking and account messages are always sent. */
export interface NotificationPrefs {
  marketingEmail: boolean;
  marketingSms: boolean;
  /** SMS when a message is still unread after 10 minutes. */
  unreadMessageSms: boolean;
  /** Email when a message is still unread after 10 minutes: on unless turned off (missing on older accounts). */
  unreadMessageEmail?: boolean;
}

export const EMAIL_PROBLEMS = ['BOUNCED', 'SUPPRESSED'] as const;

/**
 * Why emails aren't reaching the person (plan §7), from Resend's delivery webhook: the address bounced, or
 * Resend refused to send to it after earlier bounces or a spam complaint. Shown to staff on their record.
 */
export interface EmailProblem {
  kind: (typeof EMAIL_PROBLEMS)[number];
  detail?: string;
  at: Date;
}

/** The last search, for estimated totals in Saved cars. */
export interface LastSearch {
  place?: string;
  lat?: number;
  lng?: number;
  startAt?: Date;
  endAt?: Date;
}

/** A suspicious-activity signal for admins to review (plan §14). */
export interface RiskFlag {
  code: string;
  detail?: string;
  createdAt: Date;
  clearedBy?: Types.ObjectId;
  clearedAt?: Date;
}

/** The `users` collection (plan §3). */
export interface User {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  dob?: Date;
  avatarUrl?: string;
  roles: Role[];
  permissions: Permission[];
  status: UserStatus;
  suspendedReason?: string;
  emailVerifiedAt?: Date;
  /** Cleared when an email to the address is delivered again, or the address changes. */
  emailProblem?: EmailProblem;
  /** E.164, e.g. +64211234567. Set only once verified by SMS code. */
  phone?: string;
  phoneVerifiedAt?: Date;
  /** A number waiting for its SMS code (plan §6.1: a new number needs a new code). */
  pendingPhone?: string;
  agreements: Agreement[];
  mfa?: StaffMfa;
  loginFailures: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  stripeCustomerId?: string;
  favouriteVehicleIds: Types.ObjectId[];
  blockedUserIds: Types.ObjectId[];
  notificationPrefs: NotificationPrefs;
  lastSearch?: LastSearch;
  riskFlags: RiskFlag[];
  identityVerification?: IdentityVerification;
  driverLicence?: DriverLicence;
  hostProfile?: HostProfile;
  /** Account closed and anonymised (plan §8.2). */
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const agreementSchema = new Schema<Agreement>(
  {
    type: { type: String, enum: AGREEMENT_TYPES, required: true },
    version: { type: String, required: true },
    acceptedAt: { type: Date, required: true },
    ip: String,
  },
  { _id: false },
);

const userSchema = new Schema<User>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    roles: { type: [String], enum: ROLES, default: ['GUEST'] },
    permissions: { type: [String], enum: PERMISSIONS, default: [] },
    status: { type: String, enum: USER_STATUSES, default: 'ACTIVE' },
    suspendedReason: String,
    emailVerifiedAt: Date,
    emailProblem: {
      type: new Schema<EmailProblem>(
        {
          kind: { type: String, enum: EMAIL_PROBLEMS, required: true },
          detail: String,
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    phone: String,
    phoneVerifiedAt: Date,
    pendingPhone: String,
    agreements: { type: [agreementSchema], default: [] },
    mfa: {
      type: new Schema<StaffMfa>(
        {
          devices: {
            type: [
              new Schema<MfaDevice>({
                name: { type: String, required: true, trim: true, maxlength: 40 },
                secret: { type: String, required: true, select: false },
                addedAt: { type: Date, required: true },
                lastUsedAt: Date,
                lastTimeStep: Number,
              }),
            ],
            default: [],
          },
          pendingSecret: { type: String, select: false },
          enabledAt: Date,
          secret: { type: String, select: false },
          lastTimeStep: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },
    loginFailures: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
    dob: Date,
    avatarUrl: String,
    stripeCustomerId: String,
    favouriteVehicleIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Vehicle' }], default: [] },
    blockedUserIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    notificationPrefs: {
      type: new Schema<NotificationPrefs>(
        {
          marketingEmail: { type: Boolean, default: false },
          marketingSms: { type: Boolean, default: false },
          unreadMessageSms: { type: Boolean, default: false },
          unreadMessageEmail: { type: Boolean, default: true },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    lastSearch: {
      type: new Schema<LastSearch>(
        { place: String, lat: Number, lng: Number, startAt: Date, endAt: Date },
        { _id: false },
      ),
      default: undefined,
    },
    riskFlags: {
      type: [
        new Schema<RiskFlag>({
          code: { type: String, required: true },
          detail: String,
          createdAt: { type: Date, required: true },
          clearedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          clearedAt: Date,
        }),
      ],
      default: [],
    },
    identityVerification: {
      type: new Schema<IdentityVerification>(
        {
          status: { type: String, enum: VERIFICATION_STATUSES, default: 'NONE' },
          provider: String,
          providerRef: String,
          sessionStatus: String,
          lastError: String,
          reviewReason: String,
          documentType: String,
          documentNumberHash: String,
          documentDobMatched: Boolean,
          documentDobHash: String,
          startedAt: Date,
          verifiedAt: Date,
          reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          redactedAt: Date,
          earlierSessions: {
            type: [
              new Schema<EarlierIdentitySession>(
                {
                  providerRef: { type: String, required: true },
                  startedAt: { type: Date, required: true },
                  redactedAt: Date,
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    driverLicence: {
      type: new Schema<DriverLicence>(
        {
          number: { type: String, required: true, select: false },
          numberHash: { type: String, required: true },
          numberEnding: String,
          version: { type: String, match: [/^\d{3}$/, 'version must be 3 digits'] },
          country: { type: String, required: true },
          class: { type: String, enum: LICENCE_CLASSES, required: true },
          inEnglish: Boolean,
          englishProof: { type: String, enum: ENGLISH_PROOFS },
          issuedAt: Date,
          expiry: { type: Date, required: true },
          status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
          reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        },
        { _id: false },
      ),
      default: undefined,
    },
    hostProfile: {
      type: new Schema<HostProfile>(
        {
          status: { type: String, enum: HOST_STATUSES, default: 'APPLIED' },
          appliedAt: { type: Date, required: true },
          reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          reviewNotes: String,
          stripeAccountId: String,
          connectRefusals: Number,
          payoutsEnabled: { type: Boolean, default: false },
          payoutRequirements: { type: [String], default: undefined },
          payoutDelayDays: { type: Number, min: 0 },
          bio: { type: String, maxlength: 1000 },
          responseRate: { type: Number, min: 0, max: 100 },
          tripCount: { type: Number, min: 0, default: 0 },
          rating: { type: ratingSchema, default: () => ({}) },
          feesOwedCents: cents({ default: 0 }),
          refundsOwed: {
            type: [
              new Schema<RefundOwed>(
                {
                  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
                  stripeRefundId: { type: String, required: true },
                  amountCents: cents({ required: true }),
                  createdAt: { type: Date, required: true },
                },
                { _id: false },
              ),
            ],
            default: undefined,
          },
          gstRegistered: { type: Boolean, default: false },
          gstNumber: String,
        },
        { _id: false },
      ),
      default: undefined,
    },
    closedAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ roles: 1, status: 1 });
// One verified account per mobile number.
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
// The same licence on another account raises a risk flag (plan §3, Key rules).
userSchema.index(
  { 'driverLicence.numberHash': 1 },
  { partialFilterExpression: { 'driverLicence.numberHash': { $type: 'string' } } },
);
// The Host application queue.
userSchema.index({ 'hostProfile.status': 1 });

export const UserModel = model<User>('User', userSchema);
export type UserDocument = HydratedDocument<User>;
