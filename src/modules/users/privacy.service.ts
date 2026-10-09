import mongoose from 'mongoose';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { IncidentModel } from '../incidents/incident.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { openTicket } from '../support/support.service.js';
import { SupportTicketModel } from '../support/support-ticket.model.js';
import type { AccountClosure, PrivacyRequestInput, PrivacyRequestType } from './privacy.schemas.js';
import { UserModel } from './user.model.js';

/*
 * Privacy requests (NZ Privacy Act 2020, plan §8.2 and §14): a copy of a user's information, a
 * correction, or closing their account. Each becomes a PRIVACY support ticket that staff carry out.
 * An account can't be closed while something on it is still under way.
 */

const LIVE_BOOKING = ['PENDING', 'CONFIRMED', 'ACTIVE'];
const OPEN_INCIDENT = ['OPEN', 'INVESTIGATING', 'AWAITING_RESPONSE'];

const BLOCKER_MESSAGES: Record<AccountClosure['blockers'][number]['code'], string> = {
  UPCOMING_TRIP: 'You have a trip that’s requested, booked or under way. Finish or cancel it first.',
  HOSTED_BOOKING: 'One of your cars has a booking that’s requested, booked or under way.',
  OPEN_INCIDENT: 'An incident on one of your trips is still open.',
  UNPAID_CHARGE: 'There’s an extra charge from a trip still to pay.',
  PAYOUT_DUE: 'A payout is still on its way to you.',
};

/** GET /me/account-closure: whether the account can be closed now, and if not, why (plan §8.2). */
export async function accountClosure(userId: string): Promise<AccountClosure> {
  const id = new mongoose.Types.ObjectId(userId);
  const status = mongoose.trusted({ $in: LIVE_BOOKING });
  const theirBookings = await BookingModel.distinct('_id', { $or: [{ guestId: id }, { hostId: id }] });
  const [trip, hosted, incident, charge, payout] = await Promise.all([
    BookingModel.exists({ guestId: id, status }),
    BookingModel.exists({ hostId: id, status }),
    IncidentModel.exists({
      status: mongoose.trusted({ $in: OPEN_INCIDENT }),
      $or: [{ reporterId: id }, { bookingId: mongoose.trusted({ $in: theirBookings }) }],
    }),
    BookingModel.exists({
      guestId: id,
      extraCharges: mongoose.trusted({ $elemMatch: { status: { $in: ['PENDING', 'FAILED'] } } }),
    }),
    // A payout that failed is still owed to the Host, like one scheduled or held.
    PayoutModel.exists({ hostId: id, status: mongoose.trusted({ $in: ['SCHEDULED', 'HELD', 'FAILED'] }) }),
  ]);
  const found = {
    UPCOMING_TRIP: trip,
    HOSTED_BOOKING: hosted,
    OPEN_INCIDENT: incident,
    UNPAID_CHARGE: charge,
    PAYOUT_DUE: payout,
  };
  const blockers = (Object.keys(found) as (keyof typeof found)[])
    .filter((code) => found[code])
    .map((code) => ({ code, message: BLOCKER_MESSAGES[code] }));
  return { allowed: blockers.length === 0, blockers };
}

const SUBJECTS: Record<PrivacyRequestType, string> = {
  ACCESS: 'Privacy: a copy of my personal information',
  CORRECTION: 'Privacy: correct my personal information',
  CLOSE_ACCOUNT: 'Privacy: close my account',
};

const DEFAULT_MESSAGES: Record<PrivacyRequestType, string> = {
  ACCESS: 'Please send me a copy of the personal information Rento Vroom holds about me.',
  CORRECTION: '',
  CLOSE_ACCOUNT: 'Please close my Rento Vroom account and remove my personal information.',
};

/**
 * POST /me/privacy-requests: opens a PRIVACY ticket for support, or returns the one already open for
 * the same request. Closing an account is refused while anything on it is under way.
 */
export async function requestPrivacy(
  userId: string,
  input: PrivacyRequestInput,
  ip?: string,
): Promise<{ ref: string; alreadyOpen: boolean }> {
  const user = await UserModel.findById(userId).select('email firstName lastName status').lean();
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();

  if (input.type === 'CLOSE_ACCOUNT') {
    const closure = await accountClosure(userId);
    if (!closure.allowed) {
      throw new HttpError(409, 'CLOSURE_BLOCKED', closure.blockers[0]!.message, {
        blockers: closure.blockers.map((blocker) => blocker.code).join(','),
      });
    }
  }

  const subject = SUBJECTS[input.type];
  const open = await SupportTicketModel.findOne({
    userId: user._id,
    category: 'PRIVACY',
    subject,
    status: mongoose.trusted({ $ne: 'RESOLVED' }),
  })
    .select('ref')
    .lean();
  if (open) return { ref: open.ref, alreadyOpen: true };

  const { ref } = await openTicket({
    userId: user._id,
    name: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    subject,
    category: 'PRIVACY',
    body: [DEFAULT_MESSAGES[input.type], input.message].filter(Boolean).join('\n\n'),
  });
  await recordAudit({
    actorId: userId,
    action: 'privacy.requested',
    entity: 'user',
    entityId: userId,
    after: { type: input.type, ticket: ref },
    ip,
  });
  return { ref, alreadyOpen: false };
}
