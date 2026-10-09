import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { consumeAuthLink, createAuthLink } from '../auth/auth-links.js';
import {
  hashPassword,
  linkInvalid,
  passwordUsesEmail,
  sendPasswordChangedEmail,
} from '../auth/auth.service.js';
import { passwordContainsEmailName } from '../auth/password-policy.js';
import { SessionModel } from '../auth/session.model.js';
import type { UpdateMeInput } from './account.schemas.js';
import { acceptAgreements } from './agreements.js';
import { UserModel, type AgreementType } from './user.model.js';
import { nameLocked, toPublicUser, type PublicUser } from './user.service.js';

/*
 * Changes to a signed-in user's own password and email address (plan §6.1). Both need the current
 * password, so a device left signed in can't be used to take the account over.
 */

const CHANGE_EMAIL_VALID_MS = 24 * 60 * 60 * 1000;

const wrongPassword = () =>
  new HttpError(400, 'WRONG_PASSWORD', "That's not your current password.", {
    currentPassword: "That's not your current password.",
  });

async function userWithPassword(userId: string, currentPassword: string) {
  const user = await UserModel.findById(userId).select('+passwordHash');
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) throw wrongPassword();
  return user;
}

/** Sets a new password and signs out every other device; this one stays signed in (plan §6.1). */
export async function changePassword(
  auth: { userId: string; sessionId: string },
  input: { currentPassword: string; newPassword: string },
  ip?: string,
): Promise<void> {
  const user = await userWithPassword(auth.userId, input.currentPassword);
  if (input.newPassword === input.currentPassword) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      newPassword: 'Choose a password different from your current one.',
    });
  }
  if (passwordContainsEmailName(input.newPassword, user.email)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      newPassword: passwordUsesEmail().fields!.password!,
    });
  }

  await UserModel.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(input.newPassword) } },
  );
  await SessionModel.deleteMany({ userId: user._id, _id: mongoose.trusted({ $ne: auth.sessionId }) });
  await sendPasswordChangedEmail(user);
  await recordAudit({ actorId: user._id, action: 'password.changed', entity: 'user', entityId: user.id, ip });
}

/**
 * Emails a link to the new address. The current address keeps working until that link is opened
 * (plan §6.1: a new email address is verified before it replaces the old one).
 */
export async function requestEmailChange(
  userId: string,
  input: { newEmail: string; currentPassword: string },
  ip?: string,
): Promise<{ email: string }> {
  const user = await userWithPassword(userId, input.currentPassword);
  if (input.newEmail === user.email) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      newEmail: 'That is already your email address.',
    });
  }
  if (await UserModel.exists({ email: input.newEmail })) {
    throw new HttpError(409, 'EMAIL_TAKEN', 'That email address already has an account.', {
      newEmail: 'That email address already has a Rento Vroom account.',
    });
  }

  const token = await createAuthLink(user._id, 'CHANGE_EMAIL', CHANGE_EMAIL_VALID_MS, {
    email: input.newEmail,
  });
  await enqueue('email.send', {
    to: input.newEmail,
    template: 'confirmEmailChange',
    props: {
      firstName: user.firstName,
      newEmail: input.newEmail,
      confirmUrl: `${env.FRONTEND_URL}/confirm-email-change?token=${token}`,
    },
  });
  await recordAudit({
    actorId: user._id,
    action: 'email.change-requested',
    entity: 'user',
    entityId: user.id,
    after: { email: input.newEmail },
    ip,
  });
  return { email: input.newEmail };
}

/**
 * Records that the user accepted the current version of each document, with the time and their IP,
 * as a legal record (plan §6.1, §14). Earlier acceptances are kept.
 */
export async function acceptLatestAgreements(
  userId: string,
  types: AgreementType[],
  ip?: string,
): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  user.agreements.push(...acceptAgreements([...new Set(types)], ip));
  await user.save();
  return toPublicUser(user);
}

/** Switches to the new address from the link sent to it, and tells the old address. */
export async function confirmEmailChange(token: string, ip?: string): Promise<{ email: string }> {
  const link = await consumeAuthLink(token, 'CHANGE_EMAIL');
  const user = link?.email ? await UserModel.findById(link.userId) : null;
  if (!link?.email || !user || user.status !== 'ACTIVE') throw linkInvalid();
  const newEmail = link.email;

  const taken = () => new HttpError(409, 'EMAIL_TAKEN', 'That email address now belongs to another account.');
  if (await UserModel.exists({ email: newEmail, _id: mongoose.trusted({ $ne: user._id }) })) throw taken();
  try {
    // A bounce recorded for the old address no longer applies.
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { email: newEmail, emailVerifiedAt: new Date() }, $unset: { emailProblem: 1 } },
    );
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) throw taken();
    throw error;
  }

  await enqueue('email.send', {
    to: user.email,
    template: 'emailChanged',
    props: { firstName: user.firstName, newEmail, resetUrl: `${env.FRONTEND_URL}/forgot-password` },
  });
  await recordAudit({
    actorId: user._id,
    action: 'email.changed',
    entity: 'user',
    entityId: user.id,
    before: { email: user.email },
    after: { email: newEmail },
    ip,
  });
  return { email: newEmail };
}

const nameLockedError = () =>
  new HttpError(
    409,
    'NAME_LOCKED',
    'Your name has to match your verified ID now. Ask us to correct it, and we’ll check it against your ID.',
  );

/**
 * PATCH /me: corrects the person's name (plan §11). Once the identity check has passed or is being checked,
 * the name must match the ID, so it's refused here and corrected through a privacy request instead. Each
 * change goes in the audit log with the name before and after.
 */
export async function updateName(userId: string, input: UpdateMeInput, ip?: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  const before = { firstName: user.firstName, lastName: user.lastName };
  const after = {
    firstName: input.firstName ?? before.firstName,
    lastName: input.lastName ?? before.lastName,
  };
  if (after.firstName === before.firstName && after.lastName === before.lastName) return toPublicUser(user);
  if (nameLocked(user)) throw nameLockedError();

  const updated = await UserModel.findOneAndUpdate(
    {
      _id: user._id,
      status: 'ACTIVE',
      // Checked again as it's written, in case the identity check moved on meanwhile.
      'identityVerification.status': mongoose.trusted({ $nin: ['APPROVED', 'PENDING'] }),
      'identityVerification.sessionStatus': mongoose.trusted({ $ne: 'processing' }),
    },
    { $set: after },
    { new: true },
  );
  if (!updated) throw nameLockedError();

  await recordAudit({
    actorId: user._id,
    action: 'name.changed',
    entity: 'user',
    entityId: user.id,
    before,
    after,
    ip,
  });
  return toPublicUser(updated);
}
