import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/modules/admin/default-settings.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { onRiskHold, riskScore } from '../src/modules/risk/risk-policy.js';
import { raiseRiskFlag } from '../src/modules/risk/risk-flags.js';
import { checkNewAccountValue } from '../src/modules/risk/risk-signals.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createStaff, createUser } from './helpers.js';

/*
 * Risk flags add up to a score that can hold a Guest's new checkouts (plan §14), and raising one alerts staff.
 */

const flag = (code: string, cleared = false) => ({ code, ...(cleared && { clearedAt: new Date() }) });

describe('risk score', () => {
  it('adds up open flags only, weighing a Host-only flag as nothing', () => {
    expect(riskScore([flag('RADAR_WARNING'), flag('CARD_COUNTRY')])).toBe(3);
    expect(riskScore([flag('RADAR_WARNING', true), flag('CARD_COUNTRY')])).toBe(1);
    expect(riskScore([flag('HOST_CANCELLATIONS')])).toBe(0);
    expect(riskScore(undefined)).toBe(0);
  });

  it('holds at the hold score, unless the hold is switched off', () => {
    const user = { riskFlags: [flag('SHARED_CARD'), flag('FAILED_PAYMENTS')] };
    expect(onRiskHold(user, DEFAULT_SETTINGS)).toBe(true);
    expect(onRiskHold({ riskFlags: [flag('FAILED_PAYMENTS')] }, DEFAULT_SETTINGS)).toBe(false);
    const off = { risk: { ...DEFAULT_SETTINGS.risk, autoHoldEnabled: false } };
    expect(onRiskHold(user, off)).toBe(false);
  });
});

describe('raising a flag', () => {
  it('alerts staff once, and not again while the same flag is open', async () => {
    const admin = await createStaff();
    const guest = await createUser();
    expect(await raiseRiskFlag(guest._id, 'SHARED_CARD', 'Card used by 1 other account')).toBe(true);
    expect(await raiseRiskFlag(guest._id, 'SHARED_CARD', 'Card used by 1 other account')).toBe(false);
    expect(await NotificationModel.countDocuments({ userId: admin._id, type: 'RISK_FLAG_RAISED' })).toBe(1);
  });
});

describe('new account, large booking', () => {
  it('flags a big booking from a new account only', async () => {
    const now = new Date();
    const guest = await createUser();
    const fresh = { _id: guest._id, createdAt: new Date(now.getTime() - 60 * 60 * 1000) };
    await checkNewAccountValue(fresh, { ref: 'RV-AAAAAA', totalCents: 50000 }, now);
    expect((await UserModel.findById(guest._id).lean())!.riskFlags).toEqual([]);

    await checkNewAccountValue(fresh, { ref: 'RV-AAAAAA', totalCents: 200000 }, now);
    expect((await UserModel.findById(guest._id).lean())!.riskFlags).toEqual([
      expect.objectContaining({ code: 'NEW_ACCOUNT_HIGH_VALUE' }),
    ]);

    const old = await createUser({ email: 'old@example.co.nz' });
    await checkNewAccountValue(
      { _id: old._id, createdAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) },
      { ref: 'RV-BBBBBB', totalCents: 200000 },
      now,
    );
    expect((await UserModel.findById(old._id).lean())!.riskFlags).toEqual([]);
  });
});
