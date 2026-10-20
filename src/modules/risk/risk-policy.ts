import { HttpError } from '../../lib/http-error.js';
import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import type { RiskFlag } from '../users/user.model.js';
import type { RiskFlagCode } from './risk-flags.js';

/*
 * What open risk flags add up to (plan §14). Each flag weighs what it says about the Guest at checkout;
 * once the total reaches `risk.holdScore` the Guest can't start a new checkout until staff clear flags.
 * HOST_CANCELLATIONS is about a Host's own behaviour, so it doesn't count against them as a Guest.
 */
export const RISK_WEIGHTS: Record<RiskFlagCode, number> = {
  RADAR_WARNING: 2,
  DUPLICATE_LICENCE: 2,
  SHARED_CARD: 2,
  CARD_COUNTRY: 1,
  FAILED_PAYMENTS: 1,
  BOOKING_VELOCITY: 1,
  NEW_ACCOUNT_HIGH_VALUE: 1,
  REPEATED_REPORTS: 1,
  HOST_CANCELLATIONS: 0,
};

/** The total weight of the flags staff haven't cleared. */
export function riskScore(flags: readonly Pick<RiskFlag, 'code' | 'clearedAt'>[] | undefined): number {
  return (flags ?? [])
    .filter((flag) => !flag.clearedAt)
    .reduce((sum, flag) => sum + (RISK_WEIGHTS[flag.code as RiskFlagCode] ?? 1), 0);
}

/** Whether the Guest's open flags put their account on hold for new checkouts. */
export function onRiskHold(
  user: { riskFlags?: readonly Pick<RiskFlag, 'code' | 'clearedAt'>[] },
  settings: Pick<PlatformSettings, 'risk'>,
): boolean {
  return settings.risk.autoHoldEnabled && riskScore(user.riskFlags) >= settings.risk.holdScore;
}

/** Stops a new checkout for a Guest on hold. Staff lift it by clearing flags in the risk queue. */
export function assertNotOnRiskHold(
  user: { riskFlags?: readonly Pick<RiskFlag, 'code' | 'clearedAt'>[] },
  settings: Pick<PlatformSettings, 'risk'>,
) {
  if (onRiskHold(user, settings)) {
    throw new HttpError(
      409,
      'ACCOUNT_UNDER_REVIEW',
      "We're reviewing your account before you can make another booking. Please contact support.",
    );
  }
}
