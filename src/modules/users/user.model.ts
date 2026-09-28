import { Schema, model, type HydratedDocument } from 'mongoose';

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
 * The foundation subset of the `users` collection in plan §3. Phone, verification, driver licence
 * and host profile fields are added with the features that use them.
 */
export interface User {
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  permissions: string[];
  status: UserStatus;
  suspendedReason?: string;
  emailVerifiedAt?: Date;
  agreements: Agreement[];
  loginFailures: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
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
    agreements: { type: [agreementSchema], default: [] },
    loginFailures: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ roles: 1, status: 1 });

export const UserModel = model<User>('User', userSchema);
export type UserDocument = HydratedDocument<User>;
