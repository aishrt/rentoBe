import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { formatNzDateTime, formatNzdExact } from '../../lib/format.js';
import { fromNzWallClock } from '../../lib/nz-time.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditLogModel } from '../audit/audit-log.model.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import { refundIntent, statusAfterRefunds } from '../bookings/booking-payments.js';
import { completeTrip, startTrip } from '../bookings/booking-transitions.js';
import {
  bookingView,
  confirmAfterSuspension,
  findBookingFor,
  type Actor,
} from '../bookings/booking.service.js';
import { afterTripCompleted } from '../bookings/trip-completion.js';
import { IncidentModel } from '../incidents/incident.model.js';
import { postSystemMessage } from '../messages/thread-core.js';
import { notify } from '../notifications/notify.js';
import { PaymentModel, type Payment } from '../payments/payment.model.js';
import {
  recoverHostRefund,
  releaseHeldPayouts,
  reversePayoutTransfer,
  tripPayoutPending,
  type HostRefundRecovery,
} from '../payouts/payouts.service.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { SupportTicketModel } from '../support/support-ticket.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel, type VehicleStatus } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import type {
  adminBookingDetailSchema,
  adminRefundSchema,
  adminStatusEditSchema,
  bookingListQuerySchema,
} from './admin-ops.schemas.js';
import { bookingRows } from './admin-users.service.js';
import { paymentRows, payoutRows } from './admin-money.service.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Bookings in the staff portal (spec §18; plan §8.2, §9 Days 19–23): search, a booking's whole record,
 * status edits that follow the allowed transitions with the same side effects, refunds with who funds them,
 * and suspending a car.
 */

type Id = Types.ObjectId;
type BookingRecord = Booking & { _id: Id };

const PAGE_SIZE = 25;
const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The start of an NZ day given as 2026-10-07. */
export function nzDayStart(date: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return fromNzWallClock(year, month, day);
}

/** GET /admin/bookings: by reference, a Guest's or Host's name or email, status and trip dates. */
export async function listBookings(query: z.infer<typeof bookingListQuerySchema>) {
  const filter: Record<string, unknown> = {
    status: query.status ?? mongoose.trusted({ $ne: 'PAYMENT_PENDING' }),
  };
  if (query.q) {
    if (/^RV-[A-Z0-9]{6}$/i.test(query.q)) {
      filter.ref = query.q.toUpperCase();
    } else {
      const pattern = new RegExp(escape(query.q), 'i');
      const people = await UserModel.find({
        $or: [{ firstName: pattern }, { lastName: pattern }, { email: pattern }],
      })
        .select('_id')
        .limit(200)
        .lean();
      const ids = people.map((person) => person._id);
      filter.$or = [
        { guestId: mongoose.trusted({ $in: ids }) },
        { hostId: mongoose.trusted({ $in: ids }) },
        { 'vehicleSnapshot.title': pattern },
      ];
    }
  }
  if (query.from || query.to) {
    filter.startAt = mongoose.trusted({
      ...(query.from && { $gte: nzDayStart(query.from) }),
      ...(query.to && { $lt: new Date(nzDayStart(query.to).getTime() + 24 * 60 * 60 * 1000) }),
    });
  }
  const [bookings, total] = await Promise.all([
    BookingModel.find(filter)
      .sort({ startAt: -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<BookingRecord[]>(),
    BookingModel.countDocuments(filter),
  ]);
  return { bookings: await bookingRows(bookings), total, page: query.page };
}

const paidPayment = (bookingId: Id) =>
  PaymentModel.findOne({
    bookingId,
    type: 'BOOKING',
    status: mongoose.trusted({ $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] }),
  }).sort({ createdAt: -1 });

/** GET /admin/bookings/{id}: everything about one booking, for staff. */
export async function adminBookingDetail(
  actor: Actor,
  refOrId: string,
): Promise<z.infer<typeof adminBookingDetailSchema>> {
  const { booking } = await findBookingFor(actor, refOrId);
  const [people, payments, payouts, incidents, tickets, paid] = await Promise.all([
    UserModel.find({ _id: mongoose.trusted({ $in: [booking.guestId, booking.hostId] }) })
      .select('firstName lastName email phone')
      .lean(),
    PaymentModel.find({ bookingId: booking._id }).sort({ createdAt: 1 }).lean(),
    PayoutModel.find({ bookingId: booking._id }).sort({ createdAt: 1 }).lean(),
    IncidentModel.find({ bookingId: booking._id })
      .select('caseRef type status')
      .sort({ createdAt: 1 })
      .lean(),
    SupportTicketModel.find({ bookingId: booking._id })
      .select('ref subject status')
      .sort({ createdAt: 1 })
      .lean(),
    paidPayment(booking._id).lean(),
  ]);
  const person = (id: Id) => {
    const found = people.find((candidate) => candidate._id.equals(id));
    return {
      id: id.toString(),
      name: found ? `${found.firstName} ${found.lastName}` : 'Former member',
      email: found?.email ?? '',
      ...(found?.phone && { phone: found.phone }),
    };
  };
  const refunded = (paid?.refunds ?? [])
    .filter((refund) => refund.status !== 'FAILED')
    .reduce((sum, refund) => sum + refund.amountCents, 0);
  return {
    booking: await bookingView(booking, 'STAFF'),
    guest: person(booking.guestId),
    host: person(booking.hostId),
    statusHistory: booking.statusHistory.map((change) => ({
      status: change.status,
      at: change.at.toISOString(),
      ...(change.by && { by: change.by.toString() }),
      ...(change.reason && { reason: change.reason }),
    })),
    extraCharges: booking.extraCharges.map((charge) => ({
      id: charge._id!.toString(),
      type: charge.type,
      description: charge.description,
      amountCents: charge.amountCents,
      status: charge.status,
    })),
    payments: await paymentRows(payments),
    payouts: await payoutRows(payouts),
    incidents: incidents.map((incident) => ({
      ref: incident.caseRef,
      type: incident.type,
      status: incident.status,
    })),
    tickets: tickets.map((ticket) => ({ ref: ticket.ref, subject: ticket.subject, status: ticket.status })),
    refundableCents: paid ? Math.max(0, paid.amountCents - refunded) : 0,
    // A Host-funded refund then comes off the Host's next payout or the transfer (plan §8.1, item 15).
    tripPayoutSent: !(await tripPayoutPending(booking._id)),
    refundableCharges: await refundableCharges(booking, payments),
  };
}

/** Paid extra charges with money left to refund, each with whether its payout to the Host has gone. */
async function refundableCharges(
  booking: BookingRecord,
  payments: (Pick<Payment, 'type' | 'status' | 'extraChargeId' | 'amountCents' | 'refunds'> & { _id: Id })[],
) {
  const rows = [];
  for (const payment of payments) {
    if (payment.type !== 'EXTRA_CHARGE' || !payment.extraChargeId) continue;
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status)) continue;
    const charge = booking.extraCharges.find((candidate) => candidate._id?.equals(payment.extraChargeId!));
    const refunded = payment.refunds
      .filter((refund) => refund.status !== 'FAILED')
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const left = payment.amountCents - refunded;
    if (!charge || left <= 0) continue;
    rows.push({
      paymentId: payment._id.toString(),
      type: charge.type,
      description: charge.description,
      refundableCents: left,
      payoutSent: !(await tripPayoutPending(booking._id, payment.extraChargeId)),
    });
  }
  return rows;
}

/** Tells both parties support started the trip, as a check-in in the app would (plan §8.2). */
async function announceStaffStart(booking: BookingRecord, session: mongoose.ClientSession) {
  const id = booking._id.toString();
  const body = `Rento Vroom support marked your trip in the ${booking.vehicleSnapshot.title} as started. The return is due ${formatNzDateTime(booking.endAt)} (NZ time).`;
  await notify(
    {
      userId: booking.guestId,
      type: 'TRIP_STARTED',
      title: 'Your trip has started',
      body,
      link: `/trips/${booking.ref}`,
      dedupeKey: `TRIP_STARTED:${id}:GUEST`,
    },
    { session },
  );
  await notify(
    {
      userId: booking.hostId,
      type: 'TRIP_STARTED',
      title: 'The trip has started',
      body,
      link: `/host/bookings/${booking.ref}`,
      dedupeKey: `TRIP_STARTED:${id}:HOST`,
    },
    { session },
  );
}

/**
 * POST /admin/bookings/{id}/status (plan §8.2): only the allowed transitions, with the same side effects as
 * the app. ACTIVE: the trip started without a check-in in the app, so its payout can go. COMPLETED: the trip
 * is over, so the review requests, extra-kilometre check and trip counts follow.
 */
export async function editBookingStatus(
  actor: Actor,
  refOrId: string,
  input: z.infer<typeof adminStatusEditSchema>,
  ip?: string,
  now = new Date(),
) {
  const { booking } = await findBookingFor(actor, refOrId);
  const allowed = input.to === 'ACTIVE' ? 'CONFIRMED' : 'ACTIVE';
  if (booking.status !== allowed) {
    throw new HttpError(
      409,
      'TRANSITION_NOT_ALLOWED',
      input.to === 'ACTIVE'
        ? 'Only a confirmed booking can be marked as started.'
        : 'Only a trip under way can be marked as completed.',
    );
  }
  if (input.to === 'ACTIVE' && booking.startAt.getTime() - now.getTime() > 24 * 60 * 60 * 1000) {
    throw new HttpError(409, 'TOO_EARLY', 'This trip starts more than a day from now.');
  }
  const settings = await getPlatformSettings();
  const reason = `Changed by support: ${input.reason}`;
  await withTransaction(async (session) => {
    if (input.to === 'ACTIVE') {
      const started = await startTrip(booking, session, {
        by: actor.userId,
        graceMinutes: settings.trips.lateReturnGraceMinutes,
        reason,
        now,
      });
      if (!started)
        throw new HttpError(409, 'ALREADY_CHANGED', 'This booking has just changed. Please refresh.');
      await releaseHeldPayouts({ bookingId: booking._id }, 'TRIP_NOT_STARTED', { session, now });
      // The same news as a check-in in the app (plan §8.2: the same side effects).
      await postSystemMessage(
        started,
        `Rento Vroom support marked this trip as started at ${formatNzDateTime(now)} (NZ time). The return is due ${formatNzDateTime(started.endAt)}.`,
        { session, now },
      );
      await announceStaffStart(started.toObject() as BookingRecord, session);
    } else {
      const completed = await completeTrip(booking, session, { by: actor.userId, reason, now });
      if (!completed)
        throw new HttpError(409, 'ALREADY_CHANGED', 'This booking has just changed. Please refresh.');
      await postSystemMessage(
        completed,
        `Rento Vroom support marked this trip as completed at ${formatNzDateTime(now)} (NZ time).`,
        { session, now },
      );
      await afterTripCompleted(completed.toObject() as BookingRecord, null, session, now);
    }
  });
  await recordAudit({
    actorId: actor.userId,
    action: `booking.status-${input.to.toLowerCase()}`,
    entity: 'booking',
    entityId: booking.id,
    before: { status: booking.status },
    after: { status: input.to, reason: input.reason },
    ...(ip && { ip }),
  });
  return adminBookingDetail(actor, booking.id);
}

/**
 * POST /admin/bookings/{id}/refunds: a refund to the Guest's card, with the refunds permission (plan §6.2).
 * A Host-funded refund comes off the trip's payout while it's still to be sent. Once it's sent, it comes off
 * the Host's next payout, or staff can choose to reverse the Stripe transfer instead (plan §8.1, item 15).
 */
export async function adminRefund(
  actor: Actor,
  refOrId: string,
  input: z.infer<typeof adminRefundSchema>,
  ip?: string,
  now = new Date(),
) {
  const { booking } = await findBookingFor(actor, refOrId);
  // The booking's own payment, or one of its extra charges (plan §8.1, item 11).
  const payment = input.paymentId
    ? await PaymentModel.findOne({
        _id: input.paymentId,
        bookingId: booking._id,
        status: mongoose.trusted({ $in: ['SUCCEEDED', 'PARTIALLY_REFUNDED'] }),
      })
    : await paidPayment(booking._id);
  if (!payment) throw new HttpError(409, 'NOT_PAID', 'This booking has no payment to refund.');
  const extraChargeId = payment.type === 'EXTRA_CHARGE' ? payment.extraChargeId : undefined;
  const refund = await refundIntent(
    payment,
    input.amountCents,
    `refund-${payment.id}-admin-${new mongoose.Types.ObjectId().toString()}`,
  );
  const hostFunded = input.fundedBy === 'HOST' && refund.status !== 'FAILED';
  const recoverFrom = input.recoverFrom ?? 'NEXT_PAYOUT';
  // Reversing the transfer is a Stripe call, so it's made before the refund is recorded.
  const reversal =
    hostFunded && recoverFrom === 'REVERSE_TRANSFER' && !(await tripPayoutPending(booking._id, extraChargeId))
      ? await reversePayoutTransfer(booking, refund, extraChargeId)
      : undefined;
  let hostRefund: HostRefundRecovery | undefined;
  await withTransaction(async (session) => {
    const fresh = await PaymentModel.findById(payment._id).session(session);
    if (!fresh) return;
    fresh.refunds.push({
      amountCents: refund.amountCents,
      reason: input.reason,
      kind: 'STAFF',
      issuedBy: new mongoose.Types.ObjectId(actor.userId),
      fundedBy: input.fundedBy,
      stripeRefundId: refund.stripeRefundId,
      status: refund.status,
      ...(refund.failureReason && { failureReason: refund.failureReason }),
      createdAt: now,
    });
    fresh.status = statusAfterRefunds(fresh);
    await fresh.save({ session });
    // A refund Stripe refused at once never reached the Guest: the Host owes nothing for it.
    if (hostFunded && refund.status !== 'FAILED') {
      hostRefund = await recoverHostRefund(booking, refund, reversal, session, now, extraChargeId);
    }
    // A refund Stripe refused at once alerted staff instead (refundIntent); the Guest hears once it goes.
    if (refund.status === 'FAILED') return;
    await notify(
      {
        userId: booking.guestId,
        type: 'REFUND_ISSUED',
        title: 'Refund on its way',
        body: `${formatNzdExact(refund.amountCents)} back to your card for ${booking.ref}.`,
        link: `/trips/${booking.ref}`,
        email: {
          template: 'tripNotice',
          props: {
            firstName:
              (await UserModel.findById(booking.guestId).select('firstName').session(session).lean())
                ?.firstName ?? 'there',
            heading: 'We’ve refunded you',
            paragraphs: [
              `We’ve refunded ${formatNzdExact(refund.amountCents)} to the card you paid with for your trip in the ${booking.vehicleSnapshot.title}.`,
              'Refunds usually reach your account within 5 to 10 business days, depending on your bank.',
            ],
            rows: [
              { label: 'Booking', value: booking.ref },
              { label: 'Refund', value: formatNzdExact(refund.amountCents) },
            ],
            buttonLabel: 'View your trip',
            url: `${siteUrl()}/trips/${booking.ref}`,
          },
        },
        dedupeKey: `REFUND_ISSUED:${refund.stripeRefundId}`,
      },
      { session },
    );
  });
  await recordAudit({
    actorId: actor.userId,
    action: 'refund.issued',
    entity: 'booking',
    entityId: booking.id,
    after: {
      amountCents: refund.amountCents,
      fundedBy: input.fundedBy,
      reason: input.reason,
      status: refund.status,
      // How a Host-funded refund is recovered, as staff chose and as it happened (plan §8.1, item 15).
      ...(hostRefund && { recoverFrom, hostRefund }),
    },
    ...(ip && { ip }),
  });
  return { ...(await adminBookingDetail(actor, booking.id)), ...(hostRefund && { hostRefund }) };
}

export async function upcomingFor(filter: Record<string, unknown>, now: Date) {
  const bookings = await BookingModel.find({
    ...filter,
    status: mongoose.trusted({ $in: ['PENDING', 'CONFIRMED', 'ACTIVE'] }),
    endAt: mongoose.trusted({ $gt: now }),
  })
    .sort({ startAt: 1 })
    .lean<BookingRecord[]>();
  return bookingRows(bookings);
}

/** A car's state for staff, with what a suspension affects. */
async function vehicleSuspension(vehicleId: Id, now = new Date()) {
  const vehicle = await VehicleModel.findById(vehicleId).lean();
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'No such car.');
  return {
    vehicle: {
      id: vehicle._id.toString(),
      title: vehicleTitle(vehicle),
      status: vehicle.status,
    },
    upcomingBookings: await upcomingFor({ vehicleId }, now),
  };
}

async function findVehicle(id: string) {
  const vehicle = mongoose.isValidObjectId(id) ? await VehicleModel.findById(id) : null;
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'No such car.');
  return vehicle;
}

/**
 * POST /admin/vehicles/{id}/suspend (plan §8.2): hidden at once. Its upcoming bookings come back for staff,
 * who keep each one or cancel it as a platform cancellation.
 */
export async function suspendVehicle(staffId: string, vehicleId: string, reason: string, ip?: string) {
  const vehicle = await findVehicle(vehicleId);
  if (!['ACTIVE', 'INACTIVE'].includes(vehicle.status)) {
    throw new HttpError(409, 'NOT_SUSPENDABLE', 'Only a live or deactivated car can be suspended.');
  }
  const before = vehicle.status;
  vehicle.status = 'SUSPENDED';
  vehicle.reviewNotes = reason;
  await vehicle.save();
  forget('vehicles:featured');
  await recordAudit({
    actorId: staffId,
    action: 'vehicle.suspended',
    entity: 'vehicle',
    entityId: vehicle.id,
    before: { status: before },
    after: { status: 'SUSPENDED', reason },
    ...(ip && { ip }),
  });
  const host = await UserModel.findById(vehicle.hostId).select('firstName').lean();
  const title = vehicleTitle(vehicle);
  await notify({
    userId: vehicle.hostId,
    type: 'VEHICLE_SUSPENDED',
    title: `Your ${title} is suspended`,
    body: reason,
    link: `/host/vehicles/${vehicle.id}`,
    email: {
      template: 'tripNotice',
      props: {
        firstName: host?.firstName ?? 'there',
        heading: `We’ve suspended your ${title}`,
        paragraphs: [
          `Your ${title} is hidden from search and can’t take new bookings: ${reason}`,
          'Our team will be in touch about its upcoming bookings. If you have questions, reply to this email.',
        ],
        buttonLabel: 'View your car',
        url: `${siteUrl()}/host/vehicles/${vehicle.id}`,
      },
    },
    dedupeKey: `VEHICLE_SUSPENDED:${vehicle.id}:${Date.now()}`,
  });
  return vehicleSuspension(vehicle._id);
}

/** POST /admin/vehicles/{id}/unsuspend: back to how it was before the suspension. */
export async function unsuspendVehicle(staffId: string, vehicleId: string, ip?: string) {
  const vehicle = await findVehicle(vehicleId);
  if (vehicle.status !== 'SUSPENDED') throw new HttpError(409, 'NOT_SUSPENDED', 'This car isn’t suspended.');
  const last = await AuditLogModel.findOne({
    entity: 'vehicle',
    entityId: vehicle.id,
    action: 'vehicle.suspended',
  })
    .sort({ createdAt: -1 })
    .lean();
  const previous = (last?.before as { status?: VehicleStatus } | undefined)?.status;
  vehicle.status = previous === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  vehicle.reviewNotes = undefined;
  await vehicle.save();
  forget('vehicles:featured');
  // Bookings approved while it was suspended go ahead now.
  await confirmAfterSuspension({ vehicleId: vehicle._id });
  await recordAudit({
    actorId: staffId,
    action: 'vehicle.unsuspended',
    entity: 'vehicle',
    entityId: vehicle.id,
    before: { status: 'SUSPENDED' },
    after: { status: vehicle.status },
    ...(ip && { ip }),
  });
  return vehicleSuspension(vehicle._id);
}
