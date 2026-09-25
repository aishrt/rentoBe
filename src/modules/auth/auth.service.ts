import bcrypt from 'bcryptjs';
import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { isStaff, toPublicUser, type PublicUser } from '../users/user.service.js';
import type { LoginInput } from './auth.schemas.js';
import {
  REFRESH_TOKEN_TTL_MS,
  createRefreshToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from './auth.tokens.js';
import { SessionModel } from './session.model.js';

const BCRYPT_COST = 12;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: AuthTokens;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// Compared against when the email is unknown, so the response time doesn't reveal which emails exist.
let timingGuardHash: Promise<string> | undefined;
const getTimingGuardHash = () => (timingGuardHash ??= hashPassword('rento-vroom-timing-guard'));

const invalidCredentials = () =>
  new HttpError(401, 'INVALID_CREDENTIALS', "That email and password don't match our records.");

const accountLocked = (until: Date) => {
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return new HttpError(
    423,
    'ACCOUNT_LOCKED',
    `Too many unsuccessful attempts. For your security, sign-in is paused for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  );
};

const sessionEnded = () =>
  new HttpError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.');

export async function login(input: LoginInput, context: RequestContext): Promise<AuthResult> {
  const user = await UserModel.findOne({ email: input.email }).select('+passwordHash');
  if (!user) {
    await bcrypt.compare(input.password, await getTimingGuardHash());
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) throw accountLocked(user.lockedUntil);

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordMatches) {
    const lockedUntil = await recordFailedLogin(user._id);
    throw lockedUntil ? accountLocked(lockedUntil) : invalidCredentials();
  }

  if (user.status === 'SUSPENDED') {
    throw new HttpError(
      403,
      'ACCOUNT_SUSPENDED',
      'This account is suspended. Please contact support for help.',
    );
  }
  if (input.portal === 'admin' && !isStaff(user.roles)) {
    throw new HttpError(403, 'NOT_STAFF', "This account doesn't have access to the staff portal.");
  }

  await UserModel.updateOne(
    { _id: user._id },
    { $set: { loginFailures: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } },
  );

  return { user: toPublicUser(user), tokens: await startSession(user, context) };
}

/** Counts a failed password and locks sign-in once the limit is reached. Returns the lock end, if locked. */
async function recordFailedLogin(userId: Types.ObjectId): Promise<Date | null> {
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId },
    { $inc: { loginFailures: 1 } },
    { new: true },
  );
  if (!updated || updated.loginFailures < MAX_FAILED_LOGINS) return null;

  const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
  await UserModel.updateOne({ _id: userId }, { $set: { lockedUntil, loginFailures: 0 } });
  return lockedUntil;
}

async function startSession(user: UserDocument, context: RequestContext): Promise<AuthTokens> {
  const refreshToken = createRefreshToken();
  const session = await SessionModel.create({
    userId: user._id,
    refreshTokenHash: hashToken(refreshToken),
    userAgent: context.userAgent?.slice(0, 300),
    ip: context.ip,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    lastUsedAt: new Date(),
  });

  return {
    accessToken: signAccessToken({ userId: user.id, roles: user.roles, sessionId: session.id }),
    refreshToken,
  };
}

/** Swaps a valid refresh token for a new pair. Each refresh token works once (rotation, plan §6.1). */
export async function refreshSession(
  refreshToken: string | undefined,
  context: RequestContext,
): Promise<AuthResult> {
  if (!refreshToken) throw sessionEnded();
  const currentHash = hashToken(refreshToken);
  const session = await SessionModel.findOne({
    refreshTokenHash: currentHash,
    expiresAt: mongoose.trusted({ $gt: new Date() }),
  });
  if (!session) throw sessionEnded();

  const user = await UserModel.findById(session.userId);
  if (!user || user.status !== 'ACTIVE') {
    await session.deleteOne();
    throw sessionEnded();
  }

  const nextRefreshToken = createRefreshToken();
  // Matching on the old hash makes the rotation atomic: a token used twice at once only works once.
  const rotated = await SessionModel.findOneAndUpdate(
    { _id: session._id, refreshTokenHash: currentHash },
    {
      $set: {
        refreshTokenHash: hashToken(nextRefreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        lastUsedAt: new Date(),
        ip: context.ip,
        userAgent: context.userAgent?.slice(0, 300),
      },
    },
    { new: true },
  );
  if (!rotated) throw sessionEnded();

  return {
    user: toPublicUser(user),
    tokens: {
      accessToken: signAccessToken({ userId: user.id, roles: user.roles, sessionId: rotated.id }),
      refreshToken: nextRefreshToken,
    },
  };
}

/**
 * Who is signed in on this browser, for the website's first request on each page load.
 * Uses the access token if it's still valid, otherwise renews it with the refresh token, and
 * answers `user: null` for visitors who aren't signed in (rather than a 401 the browser logs as an error).
 */
export async function resumeSession(
  credentials: { accessToken?: string; refreshToken?: string },
  context: RequestContext,
): Promise<{ user: PublicUser | null; tokens?: AuthTokens }> {
  const auth = credentials.accessToken ? verifyAccessToken(credentials.accessToken) : null;
  if (auth) {
    const user = await UserModel.findById(auth.userId);
    if (user?.status === 'ACTIVE') return { user: toPublicUser(user) };
  }

  if (!credentials.refreshToken) return { user: null };
  try {
    return await refreshSession(credentials.refreshToken, context);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return { user: null };
    throw error;
  }
}

export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await SessionModel.deleteOne({ refreshTokenHash: hashToken(refreshToken) });
}
