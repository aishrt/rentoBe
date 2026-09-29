import mongoose from 'mongoose';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import type { MfaChange } from '../../emails/templates/account-emails.js';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { decrypt, encrypt } from '../../lib/encryption.js';
import { HttpError, forbidden, unauthenticated } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { MAX_MFA_DEVICES, UserModel, type UserDocument } from '../users/user.model.js';
import { isStaff, toPublicUser, type PublicUser } from '../users/user.service.js';
import { SessionModel } from './session.model.js';

/*
 * Staff two-factor sign-in with an authenticator app (plan §6.1, §14): TOTP, 6 digits every 30 s.
 * Each staff member turns it on or off for their own account in the staff portal's settings, and can
 * add a second app as a backup. Adding a second app, removing one and turning it off each need a code
 * from an app already set up. Secrets are encrypted at rest, and each code works once.
 */

const ISSUER = 'Rento Vroom';
// Accept the previous and next 30-second code too, since phone clocks drift.
const EPOCH_TOLERANCE_SECONDS = 30;
/** Used when the staff member doesn't name the app: the first, then the second. */
const DEFAULT_DEVICE_NAMES = ['Authenticator app', 'Backup authenticator'];
const WITH_SECRETS = '+mfa.devices.secret +mfa.secret +mfa.pendingSecret';

const codeInvalid = (
  field = 'code',
  message = "That code isn't right. Check the app shows Rento Vroom, and enter the newest code.",
) => new HttpError(400, 'CODE_INVALID', "That code isn't right.", { [field]: message });

const setupNotStarted = () =>
  new HttpError(400, 'MFA_SETUP_NOT_STARTED', 'Start the setup again to get a new QR code.');

const deviceLimit = () =>
  new HttpError(
    409,
    'MFA_DEVICE_LIMIT',
    `You already have ${MAX_MFA_DEVICES} authenticator apps. Remove one to add another.`,
  );

const notEnabled = () => new HttpError(409, 'MFA_NOT_ENABLED', 'Two-factor sign-in is already off.');

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
 * A user with their authenticator secrets, to check a code. An app set up before a second one was
 * possible (its secret kept in `mfa.secret`) becomes their first device here.
 */
export async function findUserWithMfaSecrets(userId: unknown): Promise<UserDocument | null> {
  const user = await UserModel.findById(userId).select(WITH_SECRETS);
  const legacySecret = user?.mfa?.secret;
  if (!user?.mfa || !legacySecret || user.mfa.devices.length > 0) return user;

  // Matching on the old secret means two requests at once convert it only once.
  await UserModel.updateOne(
    { _id: user._id, 'mfa.secret': legacySecret },
    {
      $set: {
        'mfa.devices': [
          {
            _id: new mongoose.Types.ObjectId(),
            name: DEFAULT_DEVICE_NAMES[0],
            secret: legacySecret,
            addedAt: user.mfa.enabledAt ?? new Date(),
            ...(user.mfa.lastTimeStep !== undefined && { lastTimeStep: user.mfa.lastTimeStep }),
          },
        ],
      },
      $unset: { 'mfa.secret': 1, 'mfa.lastTimeStep': 1 },
    },
  );
  return UserModel.findById(userId).select(WITH_SECRETS);
}

/** The signed-in staff member, with their secrets. */
async function findStaff(userId: string): Promise<UserDocument> {
  const user = await findUserWithMfaSecrets(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  if (!isStaff(user.roles)) throw forbidden('Two-factor sign-in is for staff accounts.');
  return user;
}

/**
 * Whether the code is right for one of this staff member's authenticator apps, and not used before.
 * The user must come from findUserWithMfaSecrets().
 */
export async function checkMfaCode(user: UserDocument, code: string): Promise<boolean> {
  for (const device of user.mfa?.devices ?? []) {
    const timeStep = await matchCode(decrypt(device.secret), code, device.lastTimeStep);
    if (timeStep === null) continue;

    // Saving the time step atomically means the same code can't be used twice, even at the same moment.
    const saved = await UserModel.updateOne(
      {
        _id: user._id,
        'mfa.devices': mongoose.trusted({
          $elemMatch: {
            _id: device._id,
            $or: [{ lastTimeStep: { $exists: false } }, { lastTimeStep: { $lt: timeStep } }],
          },
        }),
      },
      { $set: { 'mfa.devices.$.lastTimeStep': timeStep, 'mfa.devices.$.lastUsedAt': new Date() } },
    );
    return saved.modifiedCount === 1;
  }
  return false;
}

export interface MfaStatus {
  enabled: boolean;
  maxDevices: number;
  devices: { id: string; name: string; addedAt: string; lastUsedAt?: string }[];
}

function toMfaStatus(user: UserDocument): MfaStatus {
  return {
    enabled: Boolean(user.mfa?.enabledAt),
    maxDevices: MAX_MFA_DEVICES,
    devices: (user.mfa?.devices ?? []).map((device) => ({
      id: String(device._id),
      name: device.name,
      addedAt: device.addedAt.toISOString(),
      ...(device.lastUsedAt && { lastUsedAt: device.lastUsedAt.toISOString() }),
    })),
  };
}

/** Whether two-factor sign-in is on, and the authenticator apps (never their secrets). */
export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  return toMfaStatus(await findStaff(userId));
}

export interface MfaSetup {
  /** For typing into the app by hand. */
  secret: string;
  otpauthUrl: string;
  /** The otpauth URL as a QR code image (data: URL). */
  qrCode: string;
}

/** Starts adding an authenticator app, the first or a backup: a new secret, shown once as a QR code. */
export async function startMfaSetup(userId: string): Promise<MfaSetup> {
  const user = await findStaff(userId);
  if ((user.mfa?.devices.length ?? 0) >= MAX_MFA_DEVICES) throw deviceLimit();

  const secret = generateSecret();
  await UserModel.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecret': encrypt(secret) } });

  const otpauthUrl = generateURI({ issuer: ISSUER, label: user.email, secret });
  return { secret, otpauthUrl, qrCode: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240 }) };
}

/**
 * Finishes adding an authenticator app with a first code from it, which proves it has the secret.
 * The first app turns two-factor sign-in on and signs out the account's other sessions, which only
 * needed the password. A second app also needs a code from the first, so a signed-in browser alone
 * can't add one.
 */
export async function addMfaDevice(
  auth: { userId: string; sessionId: string },
  input: { code: string; name?: string; currentCode?: string },
  ip?: string,
): Promise<PublicUser> {
  const user = await findStaff(auth.userId);
  const existing = user.mfa?.devices.length ?? 0;
  if (existing >= MAX_MFA_DEVICES) throw deviceLimit();
  const pending = user.mfa?.pendingSecret;
  if (!pending) throw setupNotStarted();

  // The new app's code first: checking it uses nothing up, so a typo there doesn't cost the current code.
  const timeStep = await matchCode(decrypt(pending), input.code);
  if (timeStep === null) throw codeInvalid();

  if (existing > 0) {
    if (!input.currentCode) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
        currentCode: 'Enter a code from the app you already use',
      });
    }
    if (!(await checkMfaCode(user, input.currentCode))) {
      throw codeInvalid(
        'currentCode',
        "That code isn't right. Enter the newest code from the app you already use.",
      );
    }
  }

  const now = new Date();
  const name = input.name || DEFAULT_DEVICE_NAMES[existing] || DEFAULT_DEVICE_NAMES[0]!;
  const updated = await UserModel.findOneAndUpdate(
    {
      _id: user._id,
      'mfa.pendingSecret': pending,
      // Two tabs finishing at once can't go over the limit.
      [`mfa.devices.${MAX_MFA_DEVICES - 1}`]: mongoose.trusted({ $exists: false }),
    },
    {
      $push: {
        'mfa.devices': {
          _id: new mongoose.Types.ObjectId(),
          name,
          secret: pending,
          addedAt: now,
          lastTimeStep: timeStep,
        },
      },
      $unset: { 'mfa.pendingSecret': 1 },
      ...(existing === 0 && { $set: { 'mfa.enabledAt': now } }),
    },
    { new: true },
  );
  if (!updated) throw setupNotStarted();

  if (existing === 0) {
    await SessionModel.deleteMany({ userId: user._id, _id: mongoose.trusted({ $ne: auth.sessionId }) });
  }
  await recordAudit({
    actorId: user._id,
    action: existing === 0 ? 'mfa.enabled' : 'mfa.device.added',
    entity: 'user',
    entityId: user.id,
    after: { device: name },
    ip,
  });
  await sendMfaChangedEmail(user, existing === 0 ? 'ENABLED' : 'DEVICE_ADDED', name);
  return toPublicUser(updated);
}

/**
 * Removes one of two authenticator apps, e.g. a lost phone, with a code from either. The last one
 * can't be removed: turning two-factor sign-in off does that.
 */
export async function removeMfaDevice(
  userId: string,
  deviceId: string,
  code: string,
  ip?: string,
): Promise<MfaStatus> {
  const user = await findStaff(userId);
  const devices = user.mfa?.devices ?? [];
  const device = devices.find((candidate) => String(candidate._id) === deviceId);
  if (!device) throw new HttpError(404, 'NOT_FOUND', 'That authenticator app has already been removed.');
  if (devices.length === 1) {
    throw new HttpError(
      409,
      'MFA_LAST_DEVICE',
      'This is your only authenticator app. Turn off two-factor sign-in instead.',
    );
  }
  if (!(await checkMfaCode(user, code))) throw codeInvalid();

  // Only while another app is left, even if two removals race.
  const removed = await UserModel.updateOne(
    { _id: user._id, 'mfa.devices.1': mongoose.trusted({ $exists: true }) },
    { $pull: { 'mfa.devices': { _id: device._id } } },
  );
  if (removed.modifiedCount === 1) {
    await recordAudit({
      actorId: user._id,
      action: 'mfa.device.removed',
      entity: 'user',
      entityId: user.id,
      before: { device: device.name },
      ip,
    });
    await sendMfaChangedEmail(user, 'DEVICE_REMOVED', device.name);
  }
  return getMfaStatus(userId);
}

/** Turns two-factor sign-in off with a code from any of the staff member's apps, removing them all. */
export async function disableMfa(userId: string, code: string, ip?: string): Promise<PublicUser> {
  const user = await findStaff(userId);
  if (!user.mfa?.enabledAt) throw notEnabled();
  if (!(await checkMfaCode(user, code))) throw codeInvalid();

  const updated = await UserModel.findOneAndUpdate(
    { _id: user._id, 'mfa.enabledAt': mongoose.trusted({ $exists: true }) },
    { $unset: { mfa: 1 } },
    { new: true },
  );
  if (!updated) throw notEnabled();

  await recordAudit({
    actorId: user._id,
    action: 'mfa.disabled',
    entity: 'user',
    entityId: user.id,
    before: { devices: user.mfa.devices.map((device) => device.name) },
    after: { mfaEnabled: false },
    ip,
  });
  await sendMfaChangedEmail(user, 'DISABLED');
  return toPublicUser(updated);
}

async function sendMfaChangedEmail(user: UserDocument, change: MfaChange, deviceName?: string) {
  await enqueue('email.send', {
    to: user.email,
    template: 'mfaChanged',
    props: {
      firstName: user.firstName,
      change,
      ...(deviceName && { deviceName }),
      resetUrl: `${env.FRONTEND_URL}/forgot-password`,
    },
  });
}

/**
 * An admin resets a staff member's lost authenticator apps (plan §6.1). They're signed out
 * everywhere, sign in again with only their password, and can set up a new app in Settings.
 * Written to the audit log.
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
