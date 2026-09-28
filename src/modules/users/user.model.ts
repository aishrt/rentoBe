import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { cents, ratingSchema, type Rating } from '../../lib/model-fields.js';

export const ROLES = ['GUEST', 'HOST', 'ADMIN', 'SUPPORT'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can open the admin portal (plan §6.2). */
export const STAFF_ROLES = ['ADMIN', 'SUPPORT'] as const satisfies readonly Role[];

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

/**
 * Staff two-factor sign-in with an authenticator app (plan §6.1). The secrets are encrypted
 * (src/lib/encryption.ts) and never leave the database except to check a code.
 */
export interface StaffMfa {
  secret?: string;
  /** Set during setup, until the first code proves the app has it. */
  pendingSecret?: string;
  enabledAt?: Date;
  /** The last code's time step, so the same code can't be used twice (replay). */
  lastTimeStep?: number;
}

export const VERIFICATION_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Identity check for Guests and Hosts (plan §9, Days 19–20). ID images stay with the provider. */
export interface IdentityVerification {
  status: VerificationStatus;
  provider?: string;
  providerRef?: string;
  verifiedAt?: Date;
  reviewedBy?: Types.ObjectId;
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
  version?: string;
  country: string;
  class: LicenceClass;
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
  payoutsEnabled: boolean;
  bio?: string;
  /** Share of booking requests answered, 0–100. */
  responseRate?: number;
  tripCount: number;
  rating: Rating;
  /** Host cancellation fees not yet deducted from a payout. */
  feesOwedCents: number;
  gstRegistered: boolean;
  gstNumber?: string;
}

/** Choices for non-essential messages (plan §7). Booking and account messages are always sent. */
export interface NotificationPrefs {
  marketingEmail: boolean;
  marketingSms: boolean;
  /** SMS when a message is still unread after 10 minutes. */
  unreadMessageSms: boolean;
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
  permissions: string[];
  status: UserStatus;
  suspendedReason?: string;
  emailVerifiedAt?: Date;
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
    permissions: { type: [String], default: [] },
    status: { type: String, enum: USER_STATUSES, default: 'ACTIVE' },
    suspendedReason: String,
    emailVerifiedAt: Date,
    phone: String,
    phoneVerifiedAt: Date,
    pendingPhone: String,
    agreements: { type: [agreementSchema], default: [] },
    mfa: {
      type: new Schema<StaffMfa>(
        {
          secret: { type: String, select: false },
          pendingSecret: { type: String, select: false },
          enabledAt: Date,
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
          verifiedAt: Date,
          reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
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
          version: { type: String, match: [/^\d{3}$/, 'version must be 3 digits'] },
          country: { type: String, required: true },
          class: { type: String, enum: LICENCE_CLASSES, required: true },
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
          payoutsEnabled: { type: Boolean, default: false },
          bio: { type: String, maxlength: 1000 },
          responseRate: { type: Number, min: 0, max: 100 },
          tripCount: { type: Number, min: 0, default: 0 },
          rating: { type: ratingSchema, default: () => ({}) },
          feesOwedCents: cents({ default: 0 }),
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
