import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../../env.js';
import { notify } from '../notifications/notify.js';
import { UserModel } from '../users/user.model.js';
import { effectiveRoles, isStaff } from '../users/user.service.js';

export interface StaffAlert {
  /** E.g. TRIP_NO_CHECK_IN. */
  type: string;
  title: string;
  /** One sentence, starting lower case after "Kia ora Aroha,". */
  body: string;
  /** A staff portal path, e.g. /admin/bookings/RV-7K2Q9M. */
  link: string;
  /** The same alert is sent once, however often the job behind it runs. */
  dedupeKey: string;
}

/**
 * Alerts every active support staff member and the admin, in the staff portal's notifications and by
 * email (plan §7, admin alerts): a possible no-show, a missing check-out, a failed refund or charge.
 */
export async function alertStaff(alert: StaffAlert, { session }: { session?: ClientSession } = {}) {
  const staff = await UserModel.find({
    roles: mongoose.trusted({ $in: ['ADMIN', 'SUPPORT'] }),
    status: 'ACTIVE',
    closedAt: mongoose.trusted({ $exists: false }),
  })
    .select('email roles firstName')
    .session(session ?? null)
    .lean();
  const url = `${env.FRONTEND_URL.replace(/\/+$/, '')}${alert.link}`;
  for (const member of staff) {
    // An ADMIN role only counts on the ADMIN_EMAIL account (plan §6.2).
    if (!isStaff(effectiveRoles(member))) continue;
    await notify(
      {
        userId: member._id,
        type: alert.type,
        title: alert.title,
        body: alert.body.charAt(0).toUpperCase() + alert.body.slice(1),
        link: alert.link,
        email: {
          template: 'staffAlert',
          props: { firstName: member.firstName, title: alert.title, body: alert.body, url },
        },
        dedupeKey: `${alert.dedupeKey}:${member._id.toString()}`,
      },
      { session },
    );
  }
}
