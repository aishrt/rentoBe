import { Schema, model, type Types } from 'mongoose';

export const AUTH_TOKEN_PURPOSES = ['VERIFY_EMAIL', 'RESET_PASSWORD'] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * A single-use link sent by email: confirm an email address, or reset a password (plan §6.1).
 * Only the token's SHA-256 hash is stored, so a copy of the database can't be used to take over
 * an account.
 */
export interface AuthToken {
  userId: Types.ObjectId;
  purpose: AuthTokenPurpose;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const authTokenSchema = new Schema<AuthToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: AUTH_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    // TTL index: MongoDB deletes the link once it expires.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'authTokens', timestamps: { createdAt: true, updatedAt: false } },
);

authTokenSchema.index({ userId: 1, purpose: 1 });

export const AuthTokenModel = model<AuthToken>('AuthToken', authTokenSchema);
