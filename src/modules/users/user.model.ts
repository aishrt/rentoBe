import { Schema, model, type HydratedDocument } from 'mongoose';

export const ROLES = ['GUEST', 'HOST', 'ADMIN', 'SUPPORT'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can open the admin portal (plan §6.2). */
export const STAFF_ROLES = ['ADMIN', 'SUPPORT'] as const satisfies readonly Role[];

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * The foundation subset of the `users` collection in plan §3. Phone, verification, agreements,
 * driver licence and host profile fields are added with the features that use them.
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
  loginFailures: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

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
    loginFailures: { type: Number, default: 0 },
    lockedUntil: Date,
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ roles: 1, status: 1 });

export const UserModel = model<User>('User', userSchema);
export type UserDocument = HydratedDocument<User>;
