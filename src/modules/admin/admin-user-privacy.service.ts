import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { fromNzWallClock, nzDate } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { sendVerificationEmail } from '../auth/auth.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { IncidentModel } from '../incidents/incident.model.js';
import { MessageModel } from '../messages/message.model.js';
import { ThreadModel } from '../messages/thread.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { SupportTicketModel } from '../support/support-ticket.model.js';
import { documentDobHash } from '../users/driver-licence.service.js';
import { UserModel } from '../users/user.model.js';
import { effectiveRoles, isStaff } from '../users/user.service.js';
import type { adminUserUpdateSchema } from './admin-ops.schemas.js';
import { userDetail } from './admin-users.service.js';
import { assertNotOwnRecord } from './own-record.js';

/*
 * Privacy requests to access or correct personal information, carried out by staff (spec §18; plan §14, NZ
 * Privacy Act 2020): correcting a person's name, date of birth or email after checking them, and a copy of
 * the information held about them. Both are support's work, audit-logged, and never on their own record.
 */

type Id = Types.ObjectId;

const notFound = () => new HttpError(404, 'NOT_FOUND', 'No such user.');

async function findPerson(userId: string) {
  if (!mongoose.isValidObjectId(userId)) throw notFound();
  const user = await UserModel.findById(userId);
  if (!user) throw notFound();
  return user;
}

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

/**
 * PATCH /admin/users/{id}: corrects a person's name, date of birth or email (plan §14). A name or date of birth
 * locked by a passed identity check is changed only here, after staff have checked it, and the record notes
 * it. A new email is marked unverified and a confirmation link sent to it; the old address is told. Each
 * change is in the audit log with the details before and after. Only the admin changes a staff account.
 */
export async function correctUserDetails(
  staffId: string,
  staffRoles: readonly string[],
  userId: string,
  input: z.infer<typeof adminUserUpdateSchema>,
  ip?: string,
) {
  const user = await findPerson(userId);
  await assertNotOwnRecord(staffId, [user._id]);
  if (user.email === env.ADMIN_EMAIL && !user._id.equals(staffId)) {
    throw new HttpError(403, 'FORBIDDEN', "The admin's account can't be changed here.");
  }
  if (isStaff(effectiveRoles(user)) && !staffRoles.includes('ADMIN')) {
    throw new HttpError(403, 'FORBIDDEN', 'Only the admin can change a staff account.');
  }
  if (user.closedAt) {
    throw new HttpError(409, 'ACCOUNT_CLOSED', 'This account was closed, so its details are gone.');
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const field of ['firstName', 'lastName'] as const) {
    const value = input[field];
    if (value !== undefined && value !== user[field]) {
      before[field] = user[field];
      after[field] = value;
      set[field] = value;
    }
  }

  const identity = user.identityVerification;
  if (input.dob !== undefined) {
    const [year, month, day] = input.dob.split('-').map(Number) as [number, number, number];
    const dob = fromNzWallClock(year, month, day);
    const now = new Date();
    if (dob >= now || year < now.getUTCFullYear() - 120) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
        dob: 'Check the date of birth',
      });
    }
    if (user.dob?.getTime() !== dob.getTime()) {
      before.dob = user.dob ? nzDate(user.dob) : null;
      after.dob = input.dob;
      set.dob = dob;
      // Compared again with the date the ID showed, when the check read one.
      if (identity?.documentDobHash) {
        set['identityVerification.documentDobMatched'] =
          identity.documentDobHash === documentDobHash(input.dob);
      }
      // Members can't change it themselves once an ID check has passed (409 DOB_LOCKED): only staff, noted.
      if (identity?.status === 'APPROVED') after.identityChecked = true;
    }
  }

  const emailChanged = input.email !== undefined && input.email !== user.email;
  if (emailChanged) {
    const taken = () =>
      new HttpError(409, 'EMAIL_TAKEN', 'That email address already has an account.', {
        email: 'That email address already has a Rento Vroom account',
      });
    if (await UserModel.exists({ email: input.email, _id: mongoose.trusted({ $ne: user._id }) }))
      throw taken();
    before.email = user.email;
    after.email = input.email;
    set.email = input.email;
    unset.emailVerifiedAt = 1;
    // A bounce recorded for the old address no longer applies.
    unset.emailProblem = 1;
  }

  if (Object.keys(set).length === 0) return userDetail(userId);
  try {
    await UserModel.updateOne(
      { _id: user._id },
      { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) },
    );
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'That email address already has an account.', {
        email: 'That email address already has a Rento Vroom account',
      });
    }
    throw error;
  }

  if (emailChanged) {
    const updated = await UserModel.findById(user._id);
    if (updated) await sendVerificationEmail(updated);
    // The old address hears of it, as when a member changes it themselves.
    await enqueue('email.send', {
      to: user.email,
      template: 'emailChanged',
      props: { firstName: user.firstName, newEmail: input.email!, resetUrl: `${siteUrl()}/forgot-password` },
    });
  }
  await recordAudit({
    actorId: staffId,
    action: 'user.corrected',
    entity: 'user',
    entityId: user.id,
    before,
    after: { ...after, reason: input.reason },
    ...(ip && { ip }),
  });
  return userDetail(userId);
}

const iso = (date: Date | undefined) => date?.toISOString();

/**
 * GET /admin/users/{id}/export: a copy of the personal information held about someone, for a privacy request
 * to access it (plan §14): their account, bookings, payments and refunds, payouts, the messages they sent,
 * reviews by and about them, their support requests and the cases they reported. Other people's details,
 * internal notes and staff-only fields are left out. Any staff member can, audit-logged.
 */
export async function exportUserData(staffId: string, userId: string, ip?: string) {
  const user = await findPerson(userId);
  await assertNotOwnRecord(staffId, [user._id]);
  const id = user._id;

  const bookings = await BookingModel.find({ $or: [{ guestId: id }, { hostId: id }] })
    .sort({ createdAt: 1 })
    .lean();
  const refOf = new Map(bookings.map((booking) => [booking._id.toString(), booking.ref]));
  const bookingRef = (bookingId: Id | undefined) => (bookingId ? refOf.get(bookingId.toString()) : undefined);
  const asGuest = bookings.filter((booking) => booking.guestId.equals(id)).map((booking) => booking._id);
  const threads = await ThreadModel.find({ participantIds: id }).select('bookingId').lean();
  const threadBooking = new Map(threads.map((thread) => [thread._id.toString(), thread.bookingId]));

  const [payments, payouts, messages, reviewsBy, reviewsAbout, tickets, incidents] = await Promise.all([
    PaymentModel.find({ bookingId: mongoose.trusted({ $in: asGuest }) })
      .sort({ createdAt: 1 })
      .lean(),
    PayoutModel.find({ hostId: id }).sort({ scheduledFor: 1 }).lean(),
    MessageModel.find({
      senderId: id,
      threadId: mongoose.trusted({ $in: threads.map((thread) => thread._id) }),
    })
      .sort({ createdAt: 1 })
      .lean(),
    ReviewModel.find({ authorId: id }).sort({ createdAt: 1 }).lean(),
    ReviewModel.find({ subjectId: id, status: 'PUBLISHED' }).sort({ createdAt: 1 }).lean(),
    SupportTicketModel.find({ userId: id }).sort({ createdAt: 1 }).lean(),
    IncidentModel.find({ reporterId: id }).sort({ createdAt: 1 }).lean(),
  ]);

  const licence = user.driverLicence;
  const host = user.hostProfile;
  const data = {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      phone: user.phone ?? null,
      phoneVerified: Boolean(user.phoneVerifiedAt),
      dateOfBirth: user.dob ? nzDate(user.dob) : null,
      roles: effectiveRoles(user),
      status: user.status,
      createdAt: iso(user.createdAt),
      lastSignIn: iso(user.lastLoginAt),
      hasProfilePhoto: Boolean(user.avatarUrl),
      notificationChoices: user.notificationPrefs,
      agreements: user.agreements.map((agreement) => ({
        type: agreement.type,
        version: agreement.version,
        acceptedAt: iso(agreement.acceptedAt),
      })),
    },
    identityCheck: user.identityVerification
      ? {
          status: user.identityVerification.status,
          ...(user.identityVerification.documentType && {
            documentType: user.identityVerification.documentType,
          }),
          ...(user.identityVerification.verifiedAt && {
            verifiedAt: iso(user.identityVerification.verifiedAt),
          }),
        }
      : null,
    // The number's last characters only: the full number is shown to staff on request, never sent on.
    driverLicence: licence
      ? {
          class: licence.class,
          country: licence.country,
          numberEnding: licence.numberEnding ?? null,
          version: licence.version ?? null,
          issuedAt: licence.issuedAt ? nzDate(licence.issuedAt) : null,
          expiry: nzDate(licence.expiry),
          status: licence.status,
        }
      : null,
    hosting: host
      ? {
          status: host.status,
          appliedAt: iso(host.appliedAt),
          bio: host.bio ?? null,
          gstRegistered: host.gstRegistered,
          gstNumber: host.gstNumber ?? null,
          payoutsEnabled: host.payoutsEnabled,
          tripCount: host.tripCount,
          rating: host.rating,
          responseRate: host.responseRate ?? null,
          feesOwedCents: host.feesOwedCents,
          refundsOwed: (host.refundsOwed ?? []).map((owed) => ({
            booking: bookingRef(owed.bookingId) ?? null,
            amountCents: owed.amountCents,
          })),
        }
      : null,
    bookings: bookings.map((booking) => ({
      ref: booking.ref,
      as: booking.guestId.equals(id) ? 'GUEST' : 'HOST',
      status: booking.status,
      car: booking.vehicleSnapshot.title,
      start: iso(booking.startAt),
      end: iso(booking.endAt),
      totalCents: booking.price.totalCents,
      ...(booking.hostId.equals(id) && { hostPayoutCents: booking.price.hostPayoutCents }),
      ...(booking.cancelledAt && { cancelledAt: iso(booking.cancelledAt) }),
      extraCharges: booking.guestId.equals(id)
        ? booking.extraCharges.map((charge) => ({
            type: charge.type,
            description: charge.description,
            amountCents: charge.amountCents,
            status: charge.status,
          }))
        : [],
      createdAt: iso(booking.createdAt),
    })),
    payments: payments.map((payment) => ({
      booking: bookingRef(payment.bookingId) ?? null,
      type: payment.type,
      amountCents: payment.amountCents,
      status: payment.status,
      ...(payment.method && { method: payment.method }),
      createdAt: iso(payment.createdAt),
      refunds: payment.refunds.map((refund) => ({
        amountCents: refund.amountCents,
        status: refund.status,
        createdAt: iso(refund.createdAt),
      })),
    })),
    payouts: payouts.map((payout) => ({
      booking: bookingRef(payout.bookingId) ?? null,
      type: payout.type,
      amountCents: payout.amountCents,
      status: payout.status,
      scheduledFor: iso(payout.scheduledFor),
      ...(payout.paidAt && { paidAt: iso(payout.paidAt) }),
    })),
    messagesSent: messages.map((message) => ({
      booking: bookingRef(threadBooking.get(message.threadId.toString())) ?? null,
      body: message.body,
      files: message.attachments.length,
      sentAt: iso(message.createdAt),
    })),
    reviewsWritten: reviewsBy.map((review) => ({
      booking: bookingRef(review.bookingId) ?? null,
      direction: review.direction,
      overall: review.overall,
      body: review.body ?? null,
      status: review.status,
      createdAt: iso(review.createdAt),
    })),
    reviewsAboutThem: reviewsAbout.map((review) => ({
      booking: bookingRef(review.bookingId) ?? null,
      direction: review.direction,
      overall: review.overall,
      body: review.body ?? null,
      createdAt: iso(review.createdAt),
    })),
    supportRequests: tickets.map((ticket) => ({
      ref: ticket.ref,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      createdAt: iso(ticket.createdAt),
      // Staff's internal notes stay out.
      messages: ticket.messages
        .filter((message) => !message.internal)
        .map((message) => ({
          from: !message.authorId || message.authorId.equals(id) ? 'YOU' : 'SUPPORT',
          body: message.body,
          files: message.attachments.length,
          at: iso(message.createdAt),
        })),
    })),
    incidentsReported: incidents.map((incident) => ({
      caseRef: incident.caseRef,
      booking: bookingRef(incident.bookingId) ?? null,
      type: incident.type,
      status: incident.status,
      description: incident.description,
      createdAt: iso(incident.createdAt),
      // What they added themselves; the other party's and support's updates are left out.
      theirUpdates: incident.events
        .filter((event) => event.actorId?.equals(id) && event.visibility !== 'INTERNAL' && event.note)
        .map((event) => ({ note: event.note, at: iso(event.createdAt) })),
    })),
  };

  await recordAudit({
    actorId: staffId,
    action: 'user.exported',
    entity: 'user',
    entityId: user.id,
    ...(ip && { ip }),
  });
  return { filename: `rento-vroom-data-${user.id}-${nzDate(new Date())}.json`, data };
}
