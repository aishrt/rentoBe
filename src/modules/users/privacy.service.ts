import mongoose from 'mongoose';
import { JobModel } from '../../jobs/job.model.js';
import { HttpError, unauthenticated } from '../../lib/http-error.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { IncidentModel } from '../incidents/incident.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { openTicket, replyToMyTicket } from '../support/support.service.js';
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
const HOUR_MS = 60 * 60 * 1000;

type Blocker = AccountClosure['blockers'][number]['code'];

const BLOCKER_MESSAGES: Record<Blocker, string> = {
  UPCOMING_TRIP: 'You have a trip that’s requested, booked or under way. Finish or cancel it first.',
  HOSTED_BOOKING: 'One of your cars has a booking that’s requested, booked or under way.',
  OPEN_INCIDENT: 'An incident on one of your trips is still open.',
  UNPAID_CHARGE: 'There’s an extra charge from a trip still to pay.',
  PAYOUT_DUE: 'A payout is still on its way to you.',
  FEES_OWED:
    'You owe Host cancellation fees or a refund, which come off your next payout. Contact us to settle them.',
  REFUND_PENDING: 'A refund to your card didn’t go through. Our team will contact you to pay it another way.',
  OPEN_DISPUTE: 'A card payment on one of your trips is being disputed with the bank.',
  RECENT_TRIP:
    'You finished a trip recently. Your account can be closed once the time for reporting damage has passed.',
};

/** The same, for the staff portal's close dialog. */
const STAFF_BLOCKER_MESSAGES: Record<Blocker, string> = {
  UPCOMING_TRIP: 'They have a trip that’s requested, booked or under way.',
  HOSTED_BOOKING: 'One of their cars has a booking that’s requested, booked or under way.',
  OPEN_INCIDENT: 'An incident on one of their trips is still open.',
  UNPAID_CHARGE: 'They have an extra charge from a trip still to pay.',
  PAYOUT_DUE: 'A payout is still due to them.',
  FEES_OWED:
    'They owe Host cancellation fees or a refund: waive the fees, or wait for a payout to take them.',
  REFUND_PENDING: 'A refund to them failed: return it another way while we can still contact them.',
  OPEN_DISPUTE: 'A card dispute on one of their trips is still open.',
  RECENT_TRIP:
    'They finished a trip within the damage-report window, or its extra kilometres aren’t worked out yet.',
};

/**
 * GET /me/account-closure: whether the account can be closed now, and if not, why (plan §8.2): anything under
 * way, or money still owed either way. Closing removes the saved card, so a trip still in its damage-report
 * window, or whose extra kilometres aren't worked out yet, waits too. `audience` words the reasons for the
 * member or for staff.
 */
export async function accountClosure(
  userId: string,
  audience: 'MEMBER' | 'STAFF' = 'MEMBER',
  now = new Date(),
): Promise<AccountClosure> {
  const id = new mongoose.Types.ObjectId(userId);
  const status = mongoose.trusted({ $in: LIVE_BOOKING });
  const [settings, user, theirBookings, theirTrips, completed] = await Promise.all([
    getPlatformSettings(),
    UserModel.findById(id).select('hostProfile.feesOwedCents hostProfile.refundsOwed').lean(),
    BookingModel.distinct('_id', { $or: [{ guestId: id }, { hostId: id }] }),
    BookingModel.distinct('_id', { guestId: id }),
    BookingModel.distinct('_id', { guestId: id, status: 'COMPLETED' }),
  ]);
  const damageSince = new Date(now.getTime() - settings.trips.damageReportWindowHours * HOUR_MS);
  const [trip, hosted, incident, charge, payout, failedRefunds, dispute, recentTrip, kmToWorkOut] =
    await Promise.all([
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
      PaymentModel.find({ bookingId: mongoose.trusted({ $in: theirTrips }), 'refunds.status': 'FAILED' })
        .select('refunds')
        .lean(),
      // Not yet decided by the bank: Stripe's open statuses.
      PaymentModel.exists({
        bookingId: mongoose.trusted({ $in: theirBookings }),
        'dispute.status': mongoose.trusted({ $exists: true, $nin: ['won', 'lost', 'warning_closed'] }),
      }),
      BookingModel.exists({
        guestId: id,
        status: 'COMPLETED',
        $or: [
          {
            statusHistory: mongoose.trusted({
              $elemMatch: { status: 'COMPLETED', at: { $gt: damageSince } },
            }),
          },
          { endAt: mongoose.trusted({ $gt: damageSince }) },
        ],
      }),
      JobModel.exists({
        type: 'trip.extraCharges',
        refId: mongoose.trusted({ $in: completed.map(String) }),
        status: mongoose.trusted({ $in: ['QUEUED', 'RUNNING'] }),
      }),
    ]);
  // A failed refund still owed: no refund on the same payment has been made since, or is on its way.
  const refundOwed = failedRefunds.some((payment) =>
    payment.refunds.some(
      (failed) =>
        failed.status === 'FAILED' &&
        !payment.refunds.some((later) => later.status !== 'FAILED' && later.createdAt > failed.createdAt),
    ),
  );
  const found: Record<Blocker, unknown> = {
    UPCOMING_TRIP: trip,
    HOSTED_BOOKING: hosted,
    OPEN_INCIDENT: incident,
    UNPAID_CHARGE: charge,
    PAYOUT_DUE: payout,
    FEES_OWED:
      (user?.hostProfile?.feesOwedCents ?? 0) > 0 ||
      (user?.hostProfile?.refundsOwed ?? []).some((owed) => owed.amountCents > 0),
    REFUND_PENDING: refundOwed,
    OPEN_DISPUTE: dispute,
    RECENT_TRIP: recentTrip || kmToWorkOut,
  };
  const messages = audience === 'STAFF' ? STAFF_BLOCKER_MESSAGES : BLOCKER_MESSAGES;
  const blockers = (Object.keys(found) as Blocker[])
    .filter((code) => found[code])
    .map((code) => ({ code, message: messages[code] }));
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
 * POST /me/privacy-requests: opens a PRIVACY ticket for support, or, when the same request is already open,
 * adds what they wrote to it (a second correction is a reply on the first), which goes back to support as a
 * reply does. Closing an account is refused while anything on it is under way.
 */
export async function requestPrivacy(
  userId: string,
  input: PrivacyRequestInput,
  ip?: string,
): Promise<{ ref: string; alreadyOpen: boolean; added: boolean }> {
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
  if (open) {
    if (!input.message) return { ref: open.ref, alreadyOpen: true, added: false };
    await replyToMyTicket(userId, open.ref, { body: input.message, attachments: [] });
    await recordAudit({
      actorId: userId,
      action: 'privacy.requested',
      entity: 'user',
      entityId: userId,
      after: { type: input.type, ticket: open.ref, addedToOpen: true },
      ip,
    });
    return { ref: open.ref, alreadyOpen: true, added: true };
  }

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
  return { ref, alreadyOpen: false, added: false };
}
