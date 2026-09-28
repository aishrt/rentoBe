import { Schema, model, type Types } from 'mongoose';

export const AUTH_TOKEN_PURPOSES = [
  'VERIFY_EMAIL',
  'RESET_PASSWORD',
  'CHANGE_EMAIL',
  'MFA_CHALLENGE',
] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * A single-use token (plan §6.1): an emailed link (confirm an email address, reset a password,
 * confirm a new email address), or the step between a staff member's password and their
 * authenticator code. Only the token's SHA-256 hash is stored, so a copy of the database can't be
 * used to take over an account.
 */
export interface AuthToken {
  userId: Types.ObjectId;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  /** CHANGE_EMAIL: the new address, which replaces the current one once confirmed. */
  email?: string;
  /** MFA_CHALLENGE: wrong codes entered so far. */
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
}

const authTokenSchema = new Schema<AuthToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: AUTH_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    email: String,
    attempts: { type: Number, default: 0 },
    // TTL index: MongoDB deletes the token once it expires.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'authTokens', timestamps: { createdAt: true, updatedAt: false } },
);

authTokenSchema.index({ userId: 1, purpose: 1 });

export const AuthTokenModel = model<AuthToken>('AuthToken', authTokenSchema);
