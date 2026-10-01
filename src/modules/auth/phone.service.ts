import mongoose from 'mongoose';
import { PhoneVerifierError, getPhoneVerifier } from '../../integrations/sms/phone-verifier.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { toMobileE164 } from '../../lib/phone.js';
import { recordAudit } from '../audit/audit.service.js';
import { UserModel } from '../users/user.model.js';
import { toPublicUser, type PublicUser } from '../users/user.service.js';

/*
 * Mobile verification by SMS code (plan §6.1), used for adding a number and for changing it: a new
 * number needs a new code. NZ numbers without +64 are fine, and overseas numbers work too (spec §23).
 */

const phoneTaken = () =>
  new HttpError(409, 'PHONE_TAKEN', 'This number is already verified on another account.', {
    phone: 'This number is already verified on another Rento Vroom account.',
  });

async function activeUser(userId: string) {
  const user = await UserModel.findById(userId);
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  return user;
}

/** Texts a code to the number. Returns it in E.164, or `sent: false` if it's already the verified number. */
export async function sendPhoneCode(
  userId: string,
  input: string,
): Promise<{ phone: string; sent: boolean }> {
  const phone = toMobileE164(input);
  if (!phone) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      phone: 'Enter a mobile number that can receive texts, like 021 123 4567 or +61 412 345 678',
    });
  }

  const user = await activeUser(userId);
  if (user.phone === phone && user.phoneVerifiedAt) return { phone, sent: false };
  if (await UserModel.exists({ phone, _id: mongoose.trusted({ $ne: user._id }) })) throw phoneTaken();

  try {
    await getPhoneVerifier().sendCode(phone);
  } catch (error) {
    if (error instanceof PhoneVerifierError && error.code !== 'UNAVAILABLE') {
      throw new HttpError(error.code === 'TOO_MANY_CODES' ? 429 : 400, error.code, error.message, {
        phone: error.message,
      });
    }
    throw error;
  }

  await UserModel.updateOne({ _id: user._id }, { $set: { pendingPhone: phone } });
  return { phone, sent: true };
}

/** Checks the code for the number waiting to be verified; it then replaces any earlier number. */
export async function verifyPhoneCode(userId: string, code: string, ip?: string): Promise<PublicUser> {
  const user = await activeUser(userId);
  const phone = user.pendingPhone;
  if (!phone) {
    throw new HttpError(400, 'NO_CODE_SENT', 'Send a code to your number first.', {
      code: 'Send a code to your number first.',
    });
  }

  const verifier = getPhoneVerifier();
  if (!(await verifier.checkCode(phone, code))) {
    throw new HttpError(400, 'CODE_INVALID', "That code isn't right, or it has expired.", {
      code: "That code isn't right, or it has expired. Check it, or send a new one.",
    });
  }

  let updated;
  try {
    updated = await UserModel.findOneAndUpdate(
      { _id: user._id, pendingPhone: phone },
      { $set: { phone, phoneVerifiedAt: new Date() }, $unset: { pendingPhone: 1 } },
      { new: true },
    );
  } catch (error) {
    // Another account verified the same number in the meantime; the unique index kept theirs.
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) throw phoneTaken();
    throw error;
  }
  if (!updated) throw unauthenticated();

  await recordAudit({
    actorId: user._id,
    action: 'phone.verified',
    entity: 'user',
    entityId: user.id,
    before: { phone: user.phone ?? null },
    // "dummy": verified with the stand-in code, never texted (SMS_DRIVER=dummy).
    after: { phone, via: verifier.provider },
    ip,
  });
  return toPublicUser(updated);
}
