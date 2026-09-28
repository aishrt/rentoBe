import mongoose, { type Types } from 'mongoose';
import { AuthTokenModel, type AuthTokenPurpose } from './auth-token.model.js';
import { createRefreshToken, hashToken } from './auth.tokens.js';

/**
 * Creates a single-use link token for a user and replaces any earlier one for the same purpose, so
 * only the newest email's link works. Returns the token for the URL; only its hash is stored.
 */
export async function createAuthLink(
  userId: Types.ObjectId,
  purpose: AuthTokenPurpose,
  validForMs: number,
): Promise<string> {
  const token = createRefreshToken();
  await AuthTokenModel.deleteMany({ userId, purpose });
  await AuthTokenModel.create({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + validForMs),
  });
  return token;
}

/** Uses up a link token. Returns its user, or null if it's unknown, expired or already used. */
export async function consumeAuthLink(
  token: string,
  purpose: AuthTokenPurpose,
): Promise<Types.ObjectId | null> {
  // Deleting it in the same step as reading it means a link works exactly once, even if clicked twice.
  const link = await AuthTokenModel.findOneAndDelete({
    tokenHash: hashToken(token),
    purpose,
    expiresAt: mongoose.trusted({ $gt: new Date() }),
  });
  return link?.userId ?? null;
}
