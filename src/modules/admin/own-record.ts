import type { Types } from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { UserModel } from '../users/user.model.js';
import { effectiveRoles } from '../users/user.service.js';

/*
 * Support staff can be Guests or Hosts too (accepting an invitation adds SUPPORT to an existing account), so
 * they never decide a record about themselves (plan §6.2): their own account, a car they host, a booking they
 * are the Guest or Host on, or their own payout. The admin owns the platform and is exempt; what they do is in
 * the audit log like everything else.
 */

export const OWN_RECORD_MESSAGE = "Another team member needs to handle this, as it's about your own account.";

type SubjectId = Types.ObjectId | string | null | undefined;

/** Whether a staff member is the subject of a record and isn't the admin, so must leave it to someone else. */
export async function isOwnRecord(staffId: string, subjectIds: readonly SubjectId[]): Promise<boolean> {
  if (!subjectIds.some((id) => id?.toString() === staffId)) return false;
  // Read only when it's their own record: the account's current roles, as the staff portal's guard reads them.
  const staff = await UserModel.findById(staffId).select('email roles').lean();
  return !(staff && effectiveRoles(staff).includes('ADMIN'));
}

/** 403 OWN_RECORD when a support member is the subject of what they're about to decide. */
export async function assertNotOwnRecord(staffId: string, subjectIds: readonly SubjectId[]): Promise<void> {
  if (await isOwnRecord(staffId, subjectIds)) throw new HttpError(403, 'OWN_RECORD', OWN_RECORD_MESSAGE);
}
