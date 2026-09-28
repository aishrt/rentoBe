import mongoose, { type Types } from 'mongoose';
import { AuthTokenModel, type AuthToken, type AuthTokenPurpose } from './auth-token.model.js';
import { createRefreshToken, hashToken } from './auth.tokens.js';

/**
 * Creates a single-use token for a user and replaces any earlier one for the same purpose, so only
 * the newest works. Returns the token for the URL; only its hash is stored.
 */
export async function createAuthLink(
  userId: Types.ObjectId,
  purpose: AuthTokenPurpose,
  validForMs: number,
  extra: { email?: string } = {},
): Promise<string> {
  const token = createRefreshToken();
  await AuthTokenModel.deleteMany({ userId, purpose });
  await AuthTokenModel.create({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + validForMs),
    ...extra,
  });
  return token;
}

const unexpired = (token: string, purpose: AuthTokenPurpose) => ({
  tokenHash: hashToken(token),
  purpose,
  expiresAt: mongoose.trusted({ $gt: new Date() }),
});

/** Reads a token without using it up, e.g. to check a new password before the reset happens. */
export async function findAuthLink(token: string, purpose: AuthTokenPurpose): Promise<AuthToken | null> {
  return AuthTokenModel.findOne(unexpired(token, purpose)).lean();
}

/** Uses up a token. Returns it, or null if it's unknown, expired or already used. */
export async function consumeAuthLink(token: string, purpose: AuthTokenPurpose): Promise<AuthToken | null> {
  // Deleting it in the same step as reading it means a token works exactly once, even if sent twice.
  return AuthTokenModel.findOneAndDelete(unexpired(token, purpose)).lean();
}
