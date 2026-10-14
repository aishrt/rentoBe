import mongoose, { type ClientSession, type Types } from 'mongoose';
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
  return result.modifiedCount > 0;
}
