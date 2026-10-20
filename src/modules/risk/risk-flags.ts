import mongoose, { type ClientSession, type Types } from 'mongoose';
import { logger } from '../../integrations/logger.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { UserModel } from '../users/user.model.js';

/**
 * The suspicious-activity signals admins review (plan §9 Days 20–22, §14). Each is raised once: while one
 * is uncleared, the same code isn't added again.
 */
export const RISK_FLAG_CODES = [
  'DUPLICATE_LICENCE',
  'HOST_CANCELLATIONS',
  'FAILED_PAYMENTS',
  'BOOKING_VELOCITY',
  'CARD_COUNTRY',
  'RADAR_WARNING',
  'REPEATED_REPORTS',
  'SHARED_CARD',
  'NEW_ACCOUNT_HIGH_VALUE',
] as const;
export type RiskFlagCode = (typeof RISK_FLAG_CODES)[number];

/** Raises a risk flag on a user, unless the same one is already waiting for review. Resolves true if added. */
export async function raiseRiskFlag(
  userId: Types.ObjectId | string,
  code: RiskFlagCode,
  detail: string,
  { now = new Date(), session }: { now?: Date; session?: ClientSession } = {},
): Promise<boolean> {
  const result = await UserModel.updateOne(
    {
      _id: userId,
      riskFlags: mongoose.trusted({ $not: { $elemMatch: { code, clearedAt: { $exists: false } } } }),
    },
    { $push: { riskFlags: { code, detail, createdAt: now } } },
    { session },
  );
  if (result.modifiedCount === 0) return false;
  // Staff hear of it at once, once per flag; a failed alert never undoes the flag.
  const alert = alertStaff(
    {
      type: 'RISK_FLAG_RAISED',
      title: 'A risk flag needs a look',
      body: `${detail}.`,
      link: '/admin/risk',
      dedupeKey: `RISK_FLAG:${userId.toString()}:${code}:${now.getTime()}`,
    },
    { session },
  );
  if (session) await alert;
  else await alert.catch((error: unknown) => logger.warn({ err: error, code }, 'Risk alert not sent'));
  return true;
}
