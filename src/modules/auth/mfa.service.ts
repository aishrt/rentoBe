import mongoose from 'mongoose';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { decrypt, encrypt } from '../../lib/encryption.js';
import { HttpError, forbidden } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { isStaff, toPublicUser, type PublicUser } from '../users/user.service.js';
import { SessionModel } from './session.model.js';

/*
 * Staff two-factor sign-in with an authenticator app (plan §6.1, §14): TOTP, 6 digits every 30 s.
 * Secrets are encrypted at rest, and each code works once.
 */

const ISSUER = 'Rento Vroom';
// Accept the previous and next 30-second code too, since phone clocks drift.
const EPOCH_TOLERANCE_SECONDS = 30;

const codeInvalid = () =>
  new HttpError(400, 'CODE_INVALID', "That code isn't right.", {
    code: "That code isn't right. Check the app shows Rento Vroom, and enter the newest code.",
  });

async function matchCode(secret: string, code: string, lastTimeStep?: number) {
  const result = await verify({
    secret,
    token: code,
    epochTolerance: EPOCH_TOLERANCE_SECONDS,
    ...(lastTimeStep !== undefined && { afterTimeStep: lastTimeStep }),
  });
  // TOTP results carry the time step the code belongs to (HOTP ones don't; we only use TOTP).
  return result.valid && 'timeStep' in result ? result.timeStep : null;
}

/**
 * Whether the code is right for this staff member's authenticator, and not used before. The user
 * must be loaded with `+mfa.secret`.
 */
export async function checkMfaCode(user: UserDocument, code: string): Promise<boolean> {
  const sealed = user.mfa?.secret;
  if (!sealed) return false;
  const timeStep = await matchCode(decrypt(sealed), code, user.mfa?.lastTimeStep);
  if (timeStep === null) return false;

  // Saving the time step atomically means the same code can't be used twice, even at the same moment.
  const saved = await UserModel.updateOne(
    {
      _id: user._id,
      $or: [
        { 'mfa.lastTimeStep': mongoose.trusted({ $exists: false }) },
        { 'mfa.lastTimeStep': mongoose.trusted({ $lt: timeStep }) },
      ],
    },
    { $set: { 'mfa.lastTimeStep': timeStep } },
  );
  return saved.modifiedCount === 1;
}

export interface MfaSetup {
  /** For typing into the app by hand. */
  secret: string;
  otpauthUrl: string;
  /** The otpauth URL as a QR code image (data: URL). */
  qrCode: string;
}

/** Starts setting up the authenticator: a new secret, shown once as a QR code. */
export async function startMfaSetup(userId: string): Promise<MfaSetup> {
  const user = await UserModel.findById(userId);
  if (!user || !isStaff(user.roles)) throw forbidden('Two-factor sign-in is for staff accounts.');
  if (user.mfa?.enabledAt) {
    throw new HttpError(409, 'MFA_ALREADY_ENABLED', 'Your authenticator app is already set up.');
  }

  const secret = generateSecret();
  await UserModel.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecret': encrypt(secret) } });

  const otpauthUrl = generateURI({ issuer: ISSUER, label: user.email, secret });
  return { secret, otpauthUrl, qrCode: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }) };
}

/** Finishes setup with a first code from the app, which proves it has the secret. */
export async function enableMfa(userId: string, code: string, ip?: string): Promise<PublicUser> {
  const user = await UserModel.findById(userId).select('+mfa.pendingSecret');
  if (!user || !isStaff(user.roles)) throw forbidden('Two-factor sign-in is for staff accounts.');
  if (user.mfa?.enabledAt) {
    throw new HttpError(409, 'MFA_ALREADY_ENABLED', 'Your authenticator app is already set up.');
  }
  const pending = user.mfa?.pendingSecret;
  if (!pending) {
    throw new HttpError(400, 'MFA_SETUP_NOT_STARTED', 'Start the setup again to get a new QR code.');
  }

  const timeStep = await matchCode(decrypt(pending), code);
  if (timeStep === null) throw codeInvalid();

  const enabled = await UserModel.findOneAndUpdate(
    { _id: user._id, 'mfa.pendingSecret': pending },
    {
      $set: { 'mfa.secret': pending, 'mfa.enabledAt': new Date(), 'mfa.lastTimeStep': timeStep },
      $unset: { 'mfa.pendingSecret': 1 },
    },
    { new: true },
  );
  if (!enabled)
    throw new HttpError(400, 'MFA_SETUP_NOT_STARTED', 'Start the setup again to get a new QR code.');

  await recordAudit({ actorId: user._id, action: 'mfa.enabled', entity: 'user', entityId: user.id, ip });
  return toPublicUser(enabled);
}

/**
 * An admin resets a staff member's lost authenticator (plan §6.1). They're signed out everywhere and
 * set up a new one at their next sign-in. Written to the audit log.
 */
export async function resetStaffMfa(adminId: string, staffId: string, ip?: string): Promise<void> {
  if (adminId === staffId) {
    throw forbidden('Ask another admin to reset your authenticator, or use the create-admin script.');
  }
  const staff = mongoose.isValidObjectId(staffId) ? await UserModel.findById(staffId) : null;
  if (!staff || !isStaff(staff.roles)) {
    throw new HttpError(404, 'NOT_FOUND', 'No staff member with that id.');
  }

  await UserModel.updateOne({ _id: staff._id }, { $unset: { mfa: 1 } });
  await SessionModel.deleteMany({ userId: staff._id });
  await recordAudit({
    actorId: adminId,
    action: 'mfa.reset',
    entity: 'user',
    entityId: staff.id,
    before: { mfaEnabled: Boolean(staff.mfa?.enabledAt) },
    after: { mfaEnabled: false },
    ip,
  });
}
