import bcrypt from 'bcryptjs';
import mongoose, { type Types } from 'mongoose';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { acceptAgreements } from '../users/agreements.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { isStaff, toPublicUser, type PublicUser } from '../users/user.service.js';
import { consumeAuthLink, createAuthLink, findAuthLink } from './auth-links.js';
import { AuthTokenModel } from './auth-token.model.js';
import type { LoginInput, SignupInput } from './auth.schemas.js';
import {
  REFRESH_TOKEN_TTL_MS,
  createRefreshToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from './auth.tokens.js';
import { checkMfaCode, findUserWithMfaSecrets } from './mfa.service.js';
import { passwordContainsEmailName } from './password-policy.js';
import { SessionModel } from './session.model.js';

const BCRYPT_COST = 12;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
export const MAX_MFA_ATTEMPTS = 5;

const VERIFY_EMAIL_VALID_MS = 24 * 60 * 60 * 1000;
const RESET_PASSWORD_VALID_MS = 60 * 60 * 1000;
const MFA_CHALLENGE_VALID_MS = 5 * 60 * 1000;

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

/** A staff password was right; the authenticator code comes next (plan §6.1). */
export interface MfaChallenge {
  mfaChallenge: string;
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

const emailTaken = () =>
  new HttpError(409, 'EMAIL_TAKEN', 'An account with this email address already exists.', {
    email: 'An account with this email already exists. Log in, or reset your password.',
  });

export const linkInvalid = () =>
  new HttpError(400, 'LINK_INVALID', 'This link has expired or was already used.');

const challengeExpired = () =>
  new HttpError(
    401,
    'MFA_CHALLENGE_EXPIRED',
    'Your sign-in timed out or had too many wrong codes. Please enter your password again.',
  );

export const passwordUsesEmail = () =>
  new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
    password: "Don't use your email address in your password",
  });

const resetUrl = () => `${env.FRONTEND_URL}/forgot-password`;

/**
 * Creates a Guest account, records acceptance of the Terms and Privacy Policy, emails a link to
 * confirm the address and signs the new user in (plan §6.1). An unconfirmed email doesn't block
 * browsing or a first checkout; it's required before the first trip starts.
 */
export async function signup(input: SignupInput, context: RequestContext): Promise<AuthResult> {
  if (await UserModel.exists({ email: input.email })) throw emailTaken();

  let user: UserDocument;
  try {
    user = await UserModel.create({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      passwordHash: await hashPassword(input.password),
      roles: ['GUEST'],
      agreements: acceptAgreements(['TERMS', 'PRIVACY'], context.ip),
    });
  } catch (error) {
    // The same email signed up twice at the same moment; the unique index kept the first.
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) throw emailTaken();
    throw error;
  }

  await sendVerificationEmail(user);
  return { user: toPublicUser(user), tokens: await startSession(user, context) };
}

async function sendVerificationEmail(user: UserDocument): Promise<void> {
  const token = await createAuthLink(user._id, 'VERIFY_EMAIL', VERIFY_EMAIL_VALID_MS);
  await enqueue('email.send', {
    to: user.email,
    template: 'verifyEmail',
    props: { firstName: user.firstName, verifyUrl: `${env.FRONTEND_URL}/verify-email?token=${token}` },
  });
}

/** Confirms an email address from the emailed link. Works signed out, e.g. on another device. */
export async function verifyEmail(token: string): Promise<{ email: string }> {
  const link = await consumeAuthLink(token, 'VERIFY_EMAIL');
  const user = link && (await UserModel.findById(link.userId));
  if (!user) throw linkInvalid();

  const confirmed = await UserModel.updateOne(
    { _id: user._id, emailVerifiedAt: mongoose.trusted({ $exists: false }) },
    { $set: { emailVerifiedAt: new Date() } },
  );
  if (confirmed.modifiedCount === 1) {
    await enqueue('email.send', {
      to: user.email,
      template: 'welcome',
      props: { firstName: user.firstName, browseUrl: env.FRONTEND_URL },
    });
  }
  return { email: user.email };
}

/** Sends a new confirmation link; the previous one stops working. */
export async function resendVerification(userId: string): Promise<{ sent: boolean }> {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  if (user.emailVerifiedAt) return { sent: false };
  await sendVerificationEmail(user);
  return { sent: true };
}

/**
 * Checks the email and password. Staff who turned on two-factor sign-in get a challenge for the code
 * instead of a session (plan §6.1); everyone else is signed in.
 */
export async function login(input: LoginInput, context: RequestContext): Promise<AuthResult | MfaChallenge> {
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

  await UserModel.updateOne({ _id: user._id }, { $set: { loginFailures: 0 }, $unset: { lockedUntil: 1 } });

  if (isStaff(user.roles) && user.mfa?.enabledAt) {
    return { mfaChallenge: await createAuthLink(user._id, 'MFA_CHALLENGE', MFA_CHALLENGE_VALID_MS) };
  }

  await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return { user: toPublicUser(user), tokens: await startSession(user, context) };
}

/** The second step of a staff sign-in: a code from one of their authenticator apps. */
export async function completeMfaLogin(
  challenge: string,
  code: string,
  context: RequestContext,
): Promise<AuthResult> {
  const pending = await findAuthLink(challenge, 'MFA_CHALLENGE');
  if (!pending) throw challengeExpired();

  const user = await findUserWithMfaSecrets(pending.userId);
  if (!user || user.status !== 'ACTIVE' || !user.mfa?.enabledAt) throw challengeExpired();

  if (!(await checkMfaCode(user, code))) {
    const counted = await AuthTokenModel.findOneAndUpdate(
      { tokenHash: hashToken(challenge), purpose: 'MFA_CHALLENGE' },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (!counted || counted.attempts >= MAX_MFA_ATTEMPTS) {
      await AuthTokenModel.deleteOne({ tokenHash: hashToken(challenge) });
      throw challengeExpired();
    }
    throw new HttpError(400, 'CODE_INVALID', "That code isn't right.", {
      code: "That code isn't right. Check the app shows Rento Vroom, and enter the newest code.",
    });
  }

  // Using the challenge up here means it can't complete a second sign-in.
  if (!(await consumeAuthLink(challenge, 'MFA_CHALLENGE'))) throw challengeExpired();
  await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
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

/**
 * Emails a link to choose a new password, if the address has an account. The answer is the same
 * either way, so the form can't be used to find out who has an account.
 */
export async function forgotPassword(email: string): Promise<void> {
  const user = await UserModel.findOne({ email, status: 'ACTIVE' });
  if (!user) return;
  const token = await createAuthLink(user._id, 'RESET_PASSWORD', RESET_PASSWORD_VALID_MS);
  await enqueue('email.send', {
    to: user.email,
    template: 'resetPassword',
    props: { firstName: user.firstName, resetUrl: `${env.FRONTEND_URL}/reset-password?token=${token}` },
  });
}

/**
 * Sets a new password from the emailed link and signs the account out everywhere (plan §6.1). The
 * link also proves the email address, so it counts as confirmed. It doesn't sign in: staff still
 * need their authenticator code.
 */
export async function resetPassword(
  token: string,
  password: string,
  context: RequestContext,
): Promise<{ email: string }> {
  // Checked before the link is used up, so a password we refuse doesn't cost the visitor their link.
  const pending = await findAuthLink(token, 'RESET_PASSWORD');
  const user = pending && (await UserModel.findById(pending.userId));
  if (!user || user.status !== 'ACTIVE') throw linkInvalid();
  if (passwordContainsEmailName(password, user.email)) throw passwordUsesEmail();

  if (!(await consumeAuthLink(token, 'RESET_PASSWORD'))) throw linkInvalid();
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordHash: await hashPassword(password),
        loginFailures: 0,
        ...(!user.emailVerifiedAt && { emailVerifiedAt: new Date() }),
      },
      $unset: { lockedUntil: 1 },
    },
  );
  await SessionModel.deleteMany({ userId: user._id });
  await sendPasswordChangedEmail(user);
  await recordAudit({
    actorId: user._id,
    action: 'password.reset',
    entity: 'user',
    entityId: user.id,
    ip: context.ip,
  });
  return { email: user.email };
}

export async function sendPasswordChangedEmail(user: UserDocument): Promise<void> {
  await enqueue('email.send', {
    to: user.email,
    template: 'passwordChanged',
    props: { firstName: user.firstName, resetUrl: resetUrl() },
  });
}

export async function startSession(user: UserDocument, context: RequestContext): Promise<AuthTokens> {
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
