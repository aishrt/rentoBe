import mongoose, { type HydratedDocument, type Types } from 'mongoose';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  hashPassword,
  linkInvalid,
  passwordUsesEmail,
  sendPasswordChangedEmail,
} from '../auth/auth.service.js';
import { createRefreshToken, hashToken } from '../auth/auth.tokens.js';
import { passwordContainsEmailName } from '../auth/password-policy.js';
import { SessionModel } from '../auth/session.model.js';
import { UserModel } from '../users/user.model.js';
import { effectiveRoles } from '../users/user.service.js';
import { StaffInviteModel, type StaffInvite } from './staff-invite.model.js';
import type {
  StaffInviteDetails,
  StaffInviteInput,
  StaffInviteView,
  StaffList,
  StaffMember,
} from './staff.schemas.js';

/*
 * The staff (plan §6.2): one admin, the account whose email is ADMIN_EMAIL, and a support team the
 * admin invites. There's no other way onto the support team: sign-up only ever makes Guests, and the
 * create-admin script only sets up the admin.
 */

export const STAFF_INVITE_VALID_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const alreadyStaff = (message: string) => new HttpError(409, 'ALREADY_STAFF', message, { email: message });

const notFound = (message: string) => new HttpError(404, 'NOT_FOUND', message);

function toInviteView(invite: HydratedDocument<StaffInvite>): StaffInviteView {
  return {
    id: invite.id,
    email: invite.email,
    firstName: invite.firstName,
    lastName: invite.lastName,
    invitedAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
  };
}

/** An invitation whose link still works. MongoDB deletes expired ones within a minute or so. */
function findOpenInvite(token: string) {
  return StaffInviteModel.findOne({
    tokenHash: hashToken(token),
    expiresAt: mongoose.trusted({ $gt: new Date() }),
  });
}

/** The admin, then the support team by name, and the invitations not yet accepted, newest first. */
export async function listStaff(): Promise<StaffList> {
  const [users, invites] = await Promise.all([
    UserModel.find({ $or: [{ roles: 'SUPPORT' }, { roles: 'ADMIN', email: env.ADMIN_EMAIL }] }).select(
      'email firstName lastName roles status mfa.enabledAt lastLoginAt',
    ),
    StaffInviteModel.find({ expiresAt: mongoose.trusted({ $gt: new Date() }) }).sort({ createdAt: -1 }),
  ]);

  const staff = users
    .map((user): StaffMember => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: effectiveRoles(user).includes('ADMIN') ? 'ADMIN' : 'SUPPORT',
      status: user.status,
      mfaEnabled: Boolean(user.mfa?.enabledAt),
      ...(user.lastLoginAt && { lastLoginAt: user.lastLoginAt.toISOString() }),
    }))
    .sort(
      (a, b) =>
        Number(b.role === 'ADMIN') - Number(a.role === 'ADMIN') ||
        `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`),
    );

  return { staff, invites: invites.map(toInviteView) };
}

/**
 * Emails someone a link to join the support team. Sending another invitation to the same address
 * replaces the earlier one, so only the newest link works. The address can already have a Rento Vroom
 * account (a former support member, or someone who also rents): accepting adds Support to it.
 */
export async function inviteSupport(
  adminId: string,
  input: StaffInviteInput,
  ip?: string,
): Promise<StaffInviteView> {
  if (input.email === env.ADMIN_EMAIL) throw alreadyStaff("That's the admin's email address.");
  const existing = await UserModel.findOne({ email: input.email }).select('roles status');
  if (existing?.roles.includes('SUPPORT')) throw alreadyStaff("They're already on the support team.");
  if (existing?.status === 'SUSPENDED') {
    throw new HttpError(409, 'ACCOUNT_SUSPENDED', 'The account with this email is suspended.', {
      email: 'The account with this email is suspended',
    });
  }

  const token = createRefreshToken();
  await StaffInviteModel.deleteOne({ email: input.email });
  let invite: HydratedDocument<StaffInvite>;
  try {
    invite = await StaffInviteModel.create({
      ...input,
      tokenHash: hashToken(token),
      invitedBy: adminId,
      expiresAt: new Date(Date.now() + STAFF_INVITE_VALID_DAYS * DAY_MS),
    });
  } catch (error) {
    // The same address was invited twice at the same moment; the unique index kept the first.
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new HttpError(409, 'CONFLICT', 'This invitation was just sent. Refresh to see it.');
    }
    throw error;
  }

  const admin = await UserModel.findById(adminId).select('firstName');
  await enqueue('email.send', {
    to: input.email,
    template: 'staffInvite',
    props: {
      firstName: input.firstName,
      invitedBy: admin?.firstName ?? 'The Rento Vroom admin',
      acceptUrl: `${env.FRONTEND_URL}/admin/invite?token=${token}`,
      validDays: STAFF_INVITE_VALID_DAYS,
    },
  });
  await recordAudit({
    actorId: adminId,
    action: 'staff.invite',
    entity: 'staffInvite',
    entityId: invite.id,
    after: { email: invite.email, firstName: invite.firstName, lastName: invite.lastName },
    ip,
  });
  return toInviteView(invite);
}

/** Cancels an invitation: its link stops working. */
export async function revokeInvite(adminId: string, inviteId: string, ip?: string): Promise<void> {
  const invite = mongoose.isValidObjectId(inviteId)
    ? await StaffInviteModel.findByIdAndDelete(inviteId)
    : null;
  if (!invite) throw notFound('No open invitation with that id.');
  await recordAudit({
    actorId: adminId,
    action: 'staff.invite.revoke',
    entity: 'staffInvite',
    entityId: invite.id,
    before: { email: invite.email },
    ip,
  });
}

/**
 * Takes someone off the support team: the role, any extra permissions and their authenticator apps go,
 * and they're signed out everywhere. Their account stays, as a Guest's if they also rent, and the
 * admin can invite them again.
 */
export async function removeSupport(adminId: string, userId: string, ip?: string): Promise<void> {
  const user = mongoose.isValidObjectId(userId)
    ? await UserModel.findById(userId).select('roles permissions')
    : null;
  if (!user?.roles.includes('SUPPORT')) throw notFound('No support team member with that id.');

  await UserModel.updateOne(
    { _id: user._id },
    { $pull: { roles: 'SUPPORT' }, $set: { permissions: [] }, $unset: { mfa: 1 } },
  );
  await SessionModel.deleteMany({ userId: user._id });
  await recordAudit({
    actorId: adminId,
    action: 'staff.remove',
    entity: 'user',
    entityId: user.id,
    before: { roles: [...user.roles], permissions: [...user.permissions] },
    after: { roles: user.roles.filter((role) => role !== 'SUPPORT'), permissions: [] },
    ip,
  });
}

/** What the invitation link is for, before the person chooses a password. */
export async function checkStaffInvite(token: string): Promise<StaffInviteDetails> {
  const invite = await findOpenInvite(token);
  if (!invite) throw linkInvalid();
  return {
    email: invite.email,
    firstName: invite.firstName,
    existingAccount: Boolean(await UserModel.exists({ email: invite.email })),
  };
}

/**
 * Accepts an invitation with a password, which joins the support team: a new staff account, or Support
 * added to the account the email already has (its password is replaced and it's signed out
 * everywhere). The link proves the email address. It doesn't sign in: the person logs in to the staff
 * portal next.
 */
export async function acceptStaffInvite(
  token: string,
  password: string,
  ip?: string,
): Promise<{ email: string }> {
  // Checked before the link is used up, so a password we refuse doesn't cost them the invitation.
  const invite = await findOpenInvite(token);
  if (!invite || invite.email === env.ADMIN_EMAIL) throw linkInvalid();
  if (passwordContainsEmailName(password, invite.email)) throw passwordUsesEmail();
  const existing = await UserModel.findOne({ email: invite.email });
  if (existing?.status === 'SUSPENDED') {
    throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact the admin.');
  }

  const passwordHash = await hashPassword(password);
  // Deleting it in the same step as reading it means the link works exactly once, even if sent twice.
  if (!(await StaffInviteModel.findOneAndDelete({ _id: invite._id, tokenHash: invite.tokenHash }))) {
    throw linkInvalid();
  }

  let userId: Types.ObjectId;
  if (existing) {
    await UserModel.updateOne(
      { _id: existing._id },
      {
        $addToSet: { roles: 'SUPPORT' },
        $set: {
          passwordHash,
          loginFailures: 0,
          ...(!existing.emailVerifiedAt && { emailVerifiedAt: new Date() }),
        },
        $unset: { lockedUntil: 1 },
      },
    );
    await SessionModel.deleteMany({ userId: existing._id });
    await sendPasswordChangedEmail(existing);
    userId = existing._id;
  } else {
    try {
      const user = await UserModel.create({
        email: invite.email,
        firstName: invite.firstName,
        lastName: invite.lastName,
        passwordHash,
        roles: ['SUPPORT'],
        emailVerifiedAt: new Date(),
      });
      userId = user._id;
    } catch (error) {
      // Someone signed up with this email in the same moment; the admin can invite it again.
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) throw linkInvalid();
      throw error;
    }
  }

  await recordAudit({
    actorId: userId,
    action: 'staff.join',
    entity: 'user',
    entityId: userId.toString(),
    after: { roles: ['SUPPORT'], invitedBy: invite.invitedBy.toString() },
    ip,
  });
  return { email: invite.email };
}
