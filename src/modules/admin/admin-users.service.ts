import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { nzDate } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { SessionModel } from '../auth/session.model.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { releaseHeldPayouts } from '../payouts/payouts.service.js';
import { accountClosure } from '../users/privacy.service.js';
import { UserModel, type Role, type User } from '../users/user.model.js';
import { effectiveRoles, isStaff } from '../users/user.service.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import type { adminUserDetailSchema, adminUserRowSchema, userListQuerySchema } from './admin-ops.schemas.js';

/*
 * User management in the staff portal (spec §18; plan §6.2, §8.2): search, a person's record, suspending and
 * lifting a suspension, clearing risk flags, closing an account on request (anonymised, keeping what the
 * law requires), support staff permissions and waiving Host cancellation fees.
 */

type Id = Types.ObjectId;
type UserRecord = User & { _id: Id };
type BookingRecord = Booking & { _id: Id };
type Row = z.infer<typeof adminUserRowSchema>;

const PAGE_SIZE = 25;
const notFound = () => new HttpError(404, 'NOT_FOUND', 'No such user.');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function row(user: UserRecord): Row {
  return {
    id: user._id.toString(),
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    ...(user.phone && { phone: user.phone }),
    roles: effectiveRoles(user),
    status: user.status,
    closed: Boolean(user.closedAt),
    identityStatus: user.identityVerification?.status ?? 'NONE',
    hostStatus: user.hostProfile?.status ?? null,
    openRiskFlags: user.riskFlags.filter((flag) => !flag.clearedAt).length,
    createdAt: user.createdAt.toISOString(),
  };
}

/** GET /admin/users: search by name, email or mobile, newest first. */
export async function listUsers(query: z.infer<typeof userListQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (query.q) {
    const pattern = new RegExp(escape(query.q), 'i');
    filter.$or = [{ firstName: pattern }, { lastName: pattern }, { email: pattern }, { phone: pattern }];
  }
  if (query.role) filter.roles = query.role;
  if (query.status) filter.status = query.status;
  if (query.flagged) filter.riskFlags = mongoose.trusted({ $elemMatch: { clearedAt: { $exists: false } } });
  const [users, total] = await Promise.all([
    UserModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<UserRecord[]>(),
    UserModel.countDocuments(filter),
  ]);
  return { users: users.map(row), total, page: query.page };
}

/** Bookings as rows for staff, with each party's name. */
export async function bookingRows(bookings: BookingRecord[]) {
  const people = await UserModel.find({
    _id: mongoose.trusted({ $in: bookings.flatMap((booking) => [booking.guestId, booking.hostId]) }),
  })
    .select('firstName lastName')
    .lean();
  const name = (id: Id) => {
    const person = people.find((candidate) => candidate._id.equals(id));
    return person ? `${person.firstName} ${person.lastName}` : 'Former member';
  };
  return bookings.map((booking) => ({
    id: booking._id.toString(),
    ref: booking.ref,
    status: booking.status,
    vehicleTitle: booking.vehicleSnapshot.title,
    guest: { id: booking.guestId.toString(), name: name(booking.guestId) },
    host: { id: booking.hostId.toString(), name: name(booking.hostId) },
    start: booking.startAt.toISOString(),
    end: booking.endAt.toISOString(),
    totalCents: booking.price.totalCents,
    createdAt: booking.createdAt.toISOString(),
  }));
}

async function findUser(userId: string) {
  if (!mongoose.isValidObjectId(userId)) throw notFound();
  const user = await UserModel.findById(userId).lean<UserRecord>();
  if (!user) throw notFound();
  return user;
}

/** GET /admin/users/{id}: the person's record for staff. */
export async function userDetail(userId: string): Promise<z.infer<typeof adminUserDetailSchema>> {
  const user = await findUser(userId);
  const now = new Date();
  const [bookings, upcoming, vehicles] = await Promise.all([
    BookingModel.find({
      $or: [{ guestId: user._id }, { hostId: user._id }],
      status: mongoose.trusted({ $ne: 'PAYMENT_PENDING' }),
    })
      .sort({ startAt: -1 })
      .limit(20)
      .lean<BookingRecord[]>(),
    BookingModel.find({
      $or: [{ guestId: user._id }, { hostId: user._id }],
      status: mongoose.trusted({ $in: ['PENDING', 'CONFIRMED', 'ACTIVE'] }),
      endAt: mongoose.trusted({ $gt: now }),
    })
      .sort({ startAt: 1 })
      .lean<BookingRecord[]>(),
    VehicleModel.countDocuments({ hostId: user._id }),
  ]);
  return {
    ...row(user),
    ...(user.suspendedReason && { suspendedReason: user.suspendedReason }),
    emailVerified: Boolean(user.emailVerifiedAt),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    permissions: [...user.permissions],
    ...(user.lastLoginAt && { lastLoginAt: user.lastLoginAt.toISOString() }),
    licence: user.driverLicence
      ? {
          class: user.driverLicence.class,
          country: user.driverLicence.country,
          numberEnding: user.driverLicence.numberEnding ?? '',
          expiry: nzDate(user.driverLicence.expiry),
          status: user.driverLicence.status,
        }
      : null,
    host: user.hostProfile
      ? {
          status: user.hostProfile.status,
          payoutsEnabled: user.hostProfile.payoutsEnabled,
          feesOwedCents: user.hostProfile.feesOwedCents,
          tripCount: user.hostProfile.tripCount,
          rating: user.hostProfile.rating,
          vehicles,
        }
      : null,
    riskFlags: user.riskFlags.map((flag) => ({
      id: (flag as { _id?: Id })._id?.toString() ?? flag.code,
      code: flag.code,
      ...(flag.detail && { detail: flag.detail }),
      createdAt: flag.createdAt.toISOString(),
      ...(flag.clearedAt && { clearedAt: flag.clearedAt.toISOString() }),
    })),
    bookings: await bookingRows(bookings),
    upcomingBookings: await bookingRows(upcoming),
  };
}

/** Staff can't act on the admin, on themselves, or (support) on other staff. */
function guardTarget(target: UserRecord, staffId: string, staffRoles: readonly Role[]) {
  if (target._id.equals(staffId)) throw new HttpError(409, 'SELF', "You can't do that to your own account.");
  if (target.email === env.ADMIN_EMAIL)
    throw new HttpError(403, 'FORBIDDEN', "The admin's account can't be changed here.");
  if (isStaff(effectiveRoles(target)) && !staffRoles.includes('ADMIN')) {
    throw new HttpError(403, 'FORBIDDEN', 'Only the admin can change a staff account.');
  }
}

/**
 * POST /admin/users/{id}/suspend (plan §8.2, user suspended): they're signed out and can't sign in, their
 * listings are hidden and their payouts held. Their upcoming bookings come back for staff to decide.
 */
export async function suspendUser(
  staffId: string,
  staffRoles: readonly Role[],
  userId: string,
  reason: string,
  ip?: string,
) {
  const user = await findUser(userId);
  guardTarget(user, staffId, staffRoles);
  if (user.status === 'SUSPENDED')
    throw new HttpError(409, 'ALREADY_SUSPENDED', 'This account is already suspended.');
  await UserModel.updateOne({ _id: user._id }, { $set: { status: 'SUSPENDED', suspendedReason: reason } });
  await SessionModel.deleteMany({ userId: user._id });
  await VehicleModel.updateMany({ hostId: user._id }, { $set: { hostSuspended: true } });
  forget('vehicles:featured');
  await recordAudit({
    actorId: staffId,
    action: 'user.suspended',
    entity: 'user',
    entityId: user._id.toString(),
    before: { status: user.status },
    after: { status: 'SUSPENDED', reason },
    ...(ip && { ip }),
  });
  await notify({
    userId: user._id,
    type: 'ACCOUNT_SUSPENDED',
    title: 'Your account is suspended',
    body: reason,
    email: {
      template: 'tripNotice',
      props: {
        firstName: user.firstName,
        heading: 'Your Rento Vroom account is suspended',
        paragraphs: [
          `We've suspended your account: ${reason}`,
          'You can’t sign in or book while it’s suspended. If you think this is a mistake, reply to this email and our team will look into it.',
        ],
        buttonLabel: 'Contact us',
        url: `${env.FRONTEND_URL.replace(/\/+$/, '')}/contact`,
      },
    },
    dedupeKey: `ACCOUNT_SUSPENDED:${user._id.toString()}:${Date.now()}`,
  });
  return userDetail(userId);
}

/** POST /admin/users/{id}/unsuspend: listings back in search, and held payouts sent. */
export async function unsuspendUser(
  staffId: string,
  staffRoles: readonly Role[],
  userId: string,
  ip?: string,
) {
  const user = await findUser(userId);
  guardTarget(user, staffId, staffRoles);
  if (user.status !== 'SUSPENDED') throw new HttpError(409, 'NOT_SUSPENDED', 'This account isn’t suspended.');
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { status: 'ACTIVE' }, $unset: { suspendedReason: 1 } },
  );
  await VehicleModel.updateMany({ hostId: user._id }, { $unset: { hostSuspended: 1 } });
  await releaseHeldPayouts({ hostId: user._id }, 'SUSPENDED');
  forget('vehicles:featured');
  await recordAudit({
    actorId: staffId,
    action: 'user.unsuspended',
    entity: 'user',
    entityId: user._id.toString(),
    before: { status: 'SUSPENDED' },
    after: { status: 'ACTIVE' },
    ...(ip && { ip }),
  });
  return userDetail(userId);
}

/** POST /admin/users/{id}/risk-flags/{flagId}/clear: staff looked into it (plan §14). */
export async function clearRiskFlag(staffId: string, userId: string, flagId: string, ip?: string) {
  const user = await findUser(userId);
  const result = await UserModel.updateOne(
    {
      _id: user._id,
      'riskFlags._id': mongoose.isValidObjectId(flagId) ? flagId : null,
      'riskFlags.clearedAt': mongoose.trusted({ $exists: false }),
    },
    { $set: { 'riskFlags.$.clearedAt': new Date(), 'riskFlags.$.clearedBy': staffId } },
  );
  if (result.matchedCount === 0) throw new HttpError(404, 'NOT_FOUND', 'No open risk flag with that id.');
  await recordAudit({
    actorId: staffId,
    action: 'risk-flag.cleared',
    entity: 'user',
    entityId: userId,
    after: { flagId },
    ...(ip && { ip }),
  });
  return userDetail(userId);
}

/**
 * POST /admin/users/{id}/close: carries out a closure request (plan §8.2, NZ Privacy Act 2020). Refused while
 * a trip, booking, incident, unpaid charge or payout is under way. The account is anonymised and its listings
 * removed; bookings, payments and audit records stay for the periods the law requires.
 */
export async function closeAccount(
  staffId: string,
  staffRoles: readonly Role[],
  userId: string,
  ip?: string,
) {
  const user = await findUser(userId);
  guardTarget(user, staffId, staffRoles);
  if (user.closedAt) throw new HttpError(409, 'ALREADY_CLOSED', 'This account is already closed.');
  const closure = await accountClosure(userId);
  if (!closure.allowed) throw new HttpError(409, 'CLOSURE_BLOCKED', closure.blockers[0]!.message);
  const now = new Date();
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        email: `closed-${user._id.toString()}@closed.rentovroom.invalid`,
        firstName: 'Former',
        lastName: 'member',
        status: 'SUSPENDED',
        suspendedReason: 'Account closed at the member’s request',
        closedAt: now,
        favouriteVehicleIds: [],
        blockedUserIds: [],
        notificationPrefs: { marketingEmail: false, marketingSms: false, unreadMessageSms: false },
      },
      $unset: {
        phone: 1,
        phoneVerifiedAt: 1,
        pendingPhone: 1,
        dob: 1,
        avatarUrl: 1,
        driverLicence: 1,
        lastSearch: 1,
        stripeCustomerId: 1,
        'hostProfile.bio': 1,
      },
    },
  );
  await SessionModel.deleteMany({ userId: user._id });
  await VehicleModel.updateMany({ hostId: user._id }, { $set: { status: 'INACTIVE', hostSuspended: true } });
  forget('vehicles:featured');
  await recordAudit({
    actorId: staffId,
    action: 'user.closed',
    entity: 'user',
    entityId: userId,
    ...(ip && { ip }),
  });
  return userDetail(userId);
}

/** POST /admin/staff/{id}/permissions: the admin gives or takes a support member's refunds permission. */
export async function setStaffPermissions(adminId: string, userId: string, refunds: boolean, ip?: string) {
  const user = await findUser(userId);
  if (!user.roles.includes('SUPPORT'))
    throw new HttpError(404, 'NOT_FOUND', 'No support team member with that id.');
  await UserModel.updateOne({ _id: user._id }, { $set: { permissions: refunds ? ['REFUNDS'] : [] } });
  await recordAudit({
    actorId: adminId,
    action: 'staff.permissions',
    entity: 'user',
    entityId: userId,
    before: { permissions: [...user.permissions] },
    after: { permissions: refunds ? ['REFUNDS'] : [] },
    ...(ip && { ip }),
  });
  return userDetail(userId);
}

/** POST /admin/users/{id}/waive-host-fee: Host cancellation fees owed, waived in part or whole (plan §8.1, item 10). */
export async function waiveHostFee(
  staffId: string,
  userId: string,
  amountCents: number | undefined,
  reason: string,
  ip?: string,
) {
  const user = await findUser(userId);
  const owed = user.hostProfile?.feesOwedCents ?? 0;
  if (owed <= 0) throw new HttpError(409, 'NOTHING_OWED', 'This Host owes no cancellation fees.');
  const waived = Math.min(owed, amountCents ?? owed);
  await UserModel.updateOne({ _id: user._id }, { $inc: { 'hostProfile.feesOwedCents': -waived } });
  await recordAudit({
    actorId: staffId,
    action: 'host-fee.waived',
    entity: 'user',
    entityId: userId,
    before: { feesOwedCents: owed },
    after: { feesOwedCents: owed - waived, reason },
    ...(ip && { ip }),
  });
  return userDetail(userId);
}

/** GET /admin/risk: people with risk flags waiting for review, most flags first (plan §9, Days 20–22). */
export async function riskQueue() {
  const users = await UserModel.find({
    riskFlags: mongoose.trusted({ $elemMatch: { clearedAt: { $exists: false } } }),
  })
    .limit(200)
    .lean<UserRecord[]>();
  return users
    .map((user) => ({
      ...row(user),
      flags: user.riskFlags
        .filter((flag) => !flag.clearedAt)
        .map((flag) => ({
          id: (flag as { _id?: Id })._id?.toString() ?? flag.code,
          code: flag.code,
          ...(flag.detail && { detail: flag.detail }),
          createdAt: flag.createdAt.toISOString(),
        })),
    }))
    .sort((a, b) => b.flags.length - a.flags.length);
}
