import mongoose, { type ClientSession, type Types } from 'mongoose';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { formatNzdExact } from '../../lib/format.js';
import { HttpError } from '../../lib/http-error.js';
import type { FileAttachment } from '../../lib/model-fields.js';
import { randomRef } from '../../lib/refs.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type Booking, type ExtraChargeType } from '../bookings/booking.model.js';
import type { Actor } from '../bookings/booking.service.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { notify } from '../notifications/notify.js';
import { addExtraCharge } from '../payments/extra-charges.service.js';
import { PaymentModel } from '../payments/payment.model.js';
import { holdBookingPayouts, releaseHeldPayouts } from '../payouts/payouts.service.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { findActiveStaff, listActiveStaff } from '../staff/staff.service.js';
import { attachmentView, confirmBookingFiles } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import { isStaff } from '../users/user.service.js';
import {
  INCIDENT_TRANSITIONS,
  IncidentModel,
  OPEN_INCIDENT_STATUSES,
  type Incident,
  type IncidentEvent,
  type IncidentStatus,
} from './incident.model.js';
import type {
  IncidentAssigneeInput,
  IncidentAssignees,
  IncidentChargeInput,
  IncidentReplyInput,
  IncidentView,
  NewIncidentInput,
  StaffIncidentUpdateInput,
  StaffNewIncidentInput,
} from './incidents.schemas.js';
import { STAFF_INCIDENTS_PAGE_SIZE } from './incidents.schemas.js';
import { assertNotOwnRecord, isOwnRecord } from '../admin/own-record.js';

/*
 * Damage and incident reporting (spec §15; plan §8.2, §9 Days 20–21). The booking's Guest or Host reports
 * what happened, with photos and documents, and gets a case number; support staff can open one too, for
 * both parties, one of them or the team only. Staff take the case, post updates for both parties, one of
 * them or the team only, and move it through its statuses (INCIDENT_TRANSITIONS); every event is kept,
 * append-only. While a case is open the booking's payouts are held and its messages stay open. Resolving
 * one can add an extra charge to the Guest, linked to the case.
 */

type Id = Types.ObjectId;
type IncidentRecord = Incident & { _id: Id };
type BookingRecord = Booking & { _id: Id };
type Role = 'GUEST' | 'HOST' | 'STAFF';

const HOUR_MS = 60 * 60 * 1000;
const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const INCIDENT_BOOKING_STATUSES = ['CONFIRMED', 'ACTIVE', 'COMPLETED'];
const TYPE_WORDS: Record<Incident['type'], string> = {
  DAMAGE: 'Damage',
  ACCIDENT: 'Accident',
  THEFT: 'Theft',
  BREAKDOWN: 'Breakdown',
  CLEANING: 'Cleaning',
  FUEL: 'Fuel',
  LATE_RETURN: 'Late return',
  NO_SHOW: 'No-show',
  TOLL: 'Toll',
  FINE: 'Fine or infringement',
  DISPUTE: 'Dispute',
  OTHER: 'Other',
};

const notFound = () => new HttpError(404, 'NOT_FOUND', "We couldn't find that case.");
const roleIn = (booking: Pick<Booking, 'guestId' | 'hostId'>, userId: Id | string | undefined): Role =>
  !userId
    ? 'STAFF'
    : booking.guestId.equals(userId)
      ? 'GUEST'
      : booking.hostId.equals(userId)
        ? 'HOST'
        : 'STAFF';

/** Whether a party can see an event: their own side's, both sides', never the team's internal notes. */
const visibleTo = (event: IncidentEvent, role: Role) =>
  role === 'STAFF' || event.visibility === 'BOTH' || event.visibility === role;

/**
 * Whether a party can see the case at all: something on it is for them. A case the Guest or Host reported
 * always is; one staff opened for the other party or the team only isn't, until an update is shared.
 */
const caseVisibleTo = (incident: Pick<Incident, 'events'>, role: Role) =>
  role === 'STAFF' || incident.events.some((event) => visibleTo(event, role));

/** Who sees the case now: both parties, one of them, or the team only. */
function caseAudience(incident: Pick<Incident, 'events'>): IncidentEvent['visibility'] {
  const guest = caseVisibleTo(incident, 'GUEST');
  const host = caseVisibleTo(incident, 'HOST');
  return guest && host ? 'BOTH' : guest ? 'GUEST' : host ? 'HOST' : 'INTERNAL';
}

/**
 * Who sees a party's next update. The other party does when they see the case, except when support's
 * latest update to this party was for them alone (a question asked only them): the answer stays between
 * them and the team, as the question did. A case support opened with one side stays with that side.
 */
function replyVisibility(
  incident: Pick<Incident, 'events'>,
  booking: Pick<Booking, 'guestId' | 'hostId'>,
  role: 'GUEST' | 'HOST',
): IncidentEvent['visibility'] {
  const fromSupport = incident.events.findLast(
    (event) => roleIn(booking, event.actorId) === 'STAFF' && visibleTo(event, role),
  );
  if (fromSupport?.visibility === role) return role;
  return caseVisibleTo(incident, role === 'GUEST' ? 'HOST' : 'GUEST') ? 'BOTH' : role;
}

/**
 * Whether support is waiting for this party's answer: the case awaits a response, and support asked them (a
 * question for both sides, or for them alone), not only the other party. Their reply then hands the case back.
 */
function awaitsParty(incident: Pick<Incident, 'status' | 'events'>, role: 'GUEST' | 'HOST'): boolean {
  if (incident.status !== 'AWAITING_RESPONSE') return false;
  const askedLast = incident.events.findLast((candidate) => candidate.status === 'AWAITING_RESPONSE');
  return !askedLast || askedLast.visibility === 'INTERNAL' || visibleTo(askedLast, role);
}

/**
 * What can't be reported after the damage-report window following check-out, unless staff open the case
 * (plan §3): damage, however it's filed. Tolls, infringements, no-shows and the rest arrive later.
 */
const WINDOW_TYPES: readonly Incident['type'][] = ['DAMAGE', 'ACCIDENT', 'CLEANING', 'FUEL'];

/** Cases whose charges are covered by the protection plan beyond its excess (plan §3, Guest Agreement). */
const EXCESS_CAPPED_TYPES: readonly Incident['type'][] = ['DAMAGE', 'ACCIDENT', 'THEFT'];

/** Charges the case has added to the booking, except any cancelled. */
const caseCharges = (incident: Pick<IncidentRecord, '_id'>, booking: Pick<Booking, 'extraCharges'>) =>
  (booking.extraCharges ?? []).filter(
    (charge) => charge.incidentId?.equals(incident._id) && charge.status !== 'CANCELLED',
  );

/** Charges the plan's excess caps on a case of any type: damage, whatever the case was filed as. */
const EXCESS_CAPPED_CHARGES: readonly ExtraChargeType[] = ['DAMAGE'];
const capsCharge = (type: string | undefined) =>
  (EXCESS_CAPPED_CHARGES as readonly string[]).includes(type ?? '');

/**
 * How much more a case can charge a Guest who booked a protection plan, when the plan's excess caps it: on a
 * damage, accident or theft case, the case's charges together stay within the excess; on another case, its
 * damage charges do (`chargeType`: the charge about to be added). Undefined when nothing but the charge
 * limit applies. `types`: the charge types that count, when not all of them do.
 */
function chargeLimit(incident: Pick<IncidentRecord, '_id' | 'type'>, booking: Booking, chargeType?: string) {
  const plan = booking.protectionPlan;
  const wholeCase = EXCESS_CAPPED_TYPES.includes(incident.type);
  if (!plan || !(wholeCase || capsCharge(chargeType))) return undefined;
  const charged = caseCharges(incident, booking)
    .filter((charge) => wholeCase || capsCharge(charge.type))
    .reduce((sum, charge) => sum + charge.amountCents, 0);
  return {
    plan,
    charged,
    remaining: Math.max(0, plan.excessCents - charged),
    ...(!wholeCase && { types: EXCESS_CAPPED_CHARGES }),
  };
}

/** The description a party sees when support opened the case without sharing its first note with them. */
const NOT_SHARED_DESCRIPTION = 'Opened by Rento Vroom support.';

async function toView(
  incident: IncidentRecord,
  booking: BookingRecord,
  role: Role,
  viewerId: string,
): Promise<IncidentView> {
  const actorIds = [
    ...new Set(
      incident.events.flatMap((event) =>
        [event.actorId, event.assigneeId].flatMap((id) => (id ? [id.toString()] : [])),
      ),
    ),
  ];
  const people = await UserModel.find({ _id: mongoose.trusted({ $in: actorIds }) })
    .select('firstName')
    .lean();
  const staffName = incident.assignedTo
    ? (await UserModel.findById(incident.assignedTo).select('firstName').lean())?.firstName
    : undefined;
  const reporterRole = roleIn(booking, incident.reporterId);
  const limit = role === 'STAFF' ? chargeLimit(incident, booking) : undefined;
  const charges = (booking.extraCharges ?? []).filter((charge) => charge.incidentId?.equals(incident._id));
  // A paid charge's refunds, from the payment that paid it, as the trip page counts them (plan §8.1, item 15).
  const chargePayments = charges.some((charge) => charge.status === 'SUCCEEDED')
    ? await PaymentModel.find({ bookingId: booking._id, type: 'EXTRA_CHARGE' })
        .select('extraChargeId refunds')
        .lean()
    : [];
  const refundedCents = (charge: (typeof charges)[number]) =>
    charge.status === 'SUCCEEDED'
      ? chargePayments
          .filter((payment) =>
            charge.paymentId
              ? payment._id.equals(charge.paymentId)
              : payment.extraChargeId?.equals(charge._id!),
          )
          .flatMap((payment) => payment.refunds ?? [])
          .filter((refund) => refund.status !== 'FAILED')
          .reduce((sum, refund) => sum + refund.amountCents, 0)
      : 0;
  return {
    caseRef: incident.caseRef,
    bookingRef: booking.ref,
    vehicleTitle: booking.vehicleSnapshot.title,
    type: incident.type,
    status: incident.status,
    reportedBy: reporterRole === 'STAFF' ? 'SUPPORT' : reporterRole,
    role,
    ...(role === 'STAFF' && staffName && { assignedTo: staffName }),
    ...(role === 'STAFF' && incident.assignedTo && { assignedToId: incident.assignedTo.toString() }),
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
    description:
      !incident.events[0] || visibleTo(incident.events[0], role)
        ? incident.description
        : NOT_SHARED_DESCRIPTION,
    events: incident.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => visibleTo(event, role))
      .map(({ event, index }) => {
        const actorRole = roleIn(booking, event.actorId);
        const mine = event.actorId?.equals(viewerId) ?? false;
        return {
          id: String(index),
          action: event.action,
          by: mine ? ('YOU' as const) : actorRole === 'STAFF' ? ('SUPPORT' as const) : actorRole,
          byName:
            actorRole === 'STAFF'
              ? role === 'STAFF'
                ? (people.find((person) => person._id.equals(event.actorId!))?.firstName ?? 'Support')
                : 'Rento Vroom support'
              : (people.find((person) => person._id.equals(event.actorId!))?.firstName ?? 'Former member'),
          ...(event.note && { note: event.note }),
          attachments: event.attachments.map(attachmentView),
          visibility: event.visibility,
          ...(event.status && { status: event.status }),
          // Taking a case yourself needs no name; handing it to someone else does.
          ...(role === 'STAFF' &&
            event.assigneeId &&
            !event.assigneeId.equals(event.actorId) && {
              assignedTo:
                people.find((person) => person._id.equals(event.assigneeId!))?.firstName ?? 'Former staff',
            }),
          createdAt: event.createdAt.toISOString(),
        };
      }),
    canReply: role === 'STAFF' || (OPEN_INCIDENT_STATUSES as readonly string[]).includes(incident.status),
    ...(role !== 'STAFF' && {
      sharedWithOtherParty: replyVisibility(incident, booking, role) === 'BOTH',
      awaitingYou: awaitsParty(incident, role),
    }),
    ...(role === 'STAFF' && {
      audience: caseAudience(incident),
      nextStatuses: [...INCIDENT_TRANSITIONS[incident.status]],
    }),
    ...(role === 'STAFF' &&
      booking.protectionPlan && {
        protectionPlan: {
          name: booking.protectionPlan.name,
          excessCents: booking.protectionPlan.excessCents,
        },
      }),
    ...(limit && { chargeLimitCents: limit.remaining }),
    extraCharges: charges.map((charge) => {
      const refunded = refundedCents(charge);
      return {
        type: charge.type,
        description: charge.description,
        amountCents: charge.amountCents,
        status: charge.status,
        ...(refunded > 0 && { refundedCents: refunded }),
      };
    }),
  };
}

async function findCase(actor: Actor, caseRef: string) {
  if (!/^IN-[A-Z0-9]{6}$/i.test(caseRef)) throw notFound();
  const incident = await IncidentModel.findOne({ caseRef: caseRef.toUpperCase() }).lean<IncidentRecord>();
  if (!incident) throw notFound();
  const booking = await BookingModel.findById(incident.bookingId).lean<BookingRecord>();
  if (!booking) throw notFound();
  const role = roleIn(booking, actor.userId);
  if (role === 'STAFF' && !isStaff(actor.roles)) throw notFound();
  if (!caseVisibleTo(incident, role)) throw notFound();
  return { incident, booking, role };
}

/** Tells the booking's parties who can see the event, except whoever made it. */
async function tellParties(
  incident: IncidentRecord,
  booking: BookingRecord,
  event: IncidentEvent,
  index: number,
  heading: string,
  /** The email's first sentence, when it isn't an update on the case. */
  intro?: string,
) {
  for (const role of ['GUEST', 'HOST'] as const) {
    const userId = role === 'GUEST' ? booking.guestId : booking.hostId;
    if (!visibleTo(event, role) || event.actorId?.equals(userId)) continue;
    const person = await UserModel.findById(userId).select('firstName').lean();
    const path = `/incidents/${incident.caseRef}`;
    await notify({
      userId,
      type: 'INCIDENT_UPDATE',
      title: `${heading}: case ${incident.caseRef}`,
      body: event.note ? event.note.slice(0, 160) : `${TYPE_WORDS[incident.type]} on booking ${booking.ref}.`,
      link: path,
      email: {
        template: 'tripNotice',
        props: {
          firstName: person?.firstName ?? 'there',
          heading: `${heading}: case ${incident.caseRef}`,
          paragraphs: [
            intro ??
              `There's an update on the ${TYPE_WORDS[incident.type].toLowerCase()} case for booking ${booking.ref}, the ${booking.vehicleSnapshot.title}.`,
            ...(event.note ? [event.note] : []),
          ],
          rows: [
            { label: 'Case', value: incident.caseRef },
            { label: 'Status', value: incident.status.replace('_', ' ').toLowerCase() },
          ],
          buttonLabel: 'Open the case',
          url: `${siteUrl()}${path}`,
        },
      },
      dedupeKey: `INCIDENT_UPDATE:${incident._id.toString()}:${index}:${role}`,
    });
  }
}

const FLAGGED_BY: Record<Role, string> = { GUEST: 'the guest', HOST: 'the host', STAFF: 'support' };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The new damage on the booking's check-out record that no case has yet: the pins on the car diagram,
 * and the damage photos taken at check-out or flagged since. A case opened with it keeps the photos as
 * evidence and the pins' notes in its description, so nobody has to describe the damage twice.
 */
async function unclaimedCheckOutDamage(booking: BookingRecord) {
  const [checkOut, cases] = await Promise.all([
    ConditionReportModel.findOne({ bookingId: booking._id, stage: 'CHECK_OUT' })
      .select('damagePins photos')
      .lean(),
    IncidentModel.find({ bookingId: booking._id })
      .select('damagePinIds events.attachments.url')
      .lean<Pick<IncidentRecord, 'damagePinIds' | 'events'>[]>(),
  ]);
  const claimedPins = new Set(cases.flatMap((other) => (other.damagePinIds ?? []).map(String)));
  const claimedFiles = new Set(
    cases.flatMap((other) => other.events.flatMap((event) => event.attachments.map((file) => file.url))),
  );
  const pins = (checkOut?.damagePins ?? []).filter(
    (pin) => pin.newDamage && pin._id && !claimedPins.has(pin._id.toString()),
  );
  const photos = (checkOut?.photos ?? []).filter(
    (photo) => photo.angle === 'DAMAGE' && !claimedFiles.has(photo.url),
  );
  if (pins.length === 0 && photos.length === 0) {
    throw new HttpError(
      409,
      'NO_NEW_DAMAGE',
      'There’s no new damage on the check-out record that isn’t already in a case. Describe the damage instead.',
    );
  }
  return {
    pinIds: pins.map((pin) => pin._id!),
    attachments: photos.map((photo, index): FileAttachment => ({
      url: photo.url,
      name: `Check-out damage photo ${index + 1}`,
    })),
    summary: [
      `New damage flagged on the check-out record: ${[
        pins.length > 0 && `${plural(pins.length, 'mark')} on the car diagram`,
        photos.length > 0 && plural(photos.length, 'photo'),
      ]
        .filter(Boolean)
        .join(' and ')}.`,
      ...pins.map(
        (pin) =>
          `- ${pin.note || 'Marked on the car diagram'} (flagged by ${FLAGGED_BY[roleIn(booking, pin.flaggedBy)]})`,
      ),
    ].join('\n'),
  };
}

/** A new OPEN case with its case number, opened by its first event. */
async function createCase(fields: {
  bookingId: Id;
  reporterId: Id;
  type: Incident['type'];
  description: string;
  damagePinIds?: Id[];
  attachments: FileAttachment[];
  visibility: IncidentEvent['visibility'];
  assignedTo?: Id;
  now: Date;
}): Promise<IncidentRecord> {
  const { attachments, visibility, now, ...rest } = fields;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const created = await IncidentModel.create({
        ...rest,
        caseRef: randomRef('IN'),
        status: 'OPEN',
        events: [
          {
            actorId: fields.reporterId,
            action: 'OPENED',
            note: fields.description,
            attachments,
            visibility,
            status: 'OPEN',
            createdAt: now,
          },
        ],
      });
      return created.toObject() as IncidentRecord;
    } catch (error) {
      // Another case took the same number: try another.
      if (!(error instanceof mongoose.mongo.MongoServerError && error.code === 11000) || attempt >= 3)
        throw error;
    }
  }
}

/**
 * POST /incidents: the Guest or Host reports an incident on their booking. A damage report must arrive
 * within the damage-report window after check-out (plan §3, validation rules). With fromCheckOutDamage,
 * a damage report opens with the damage flagged at check-out: its photos, pins and notes.
 */
export async function reportIncident(
  actor: Actor,
  input: NewIncidentInput,
  now = new Date(),
): Promise<IncidentView> {
  const booking = await BookingModel.findOne({ ref: input.bookingRef.toUpperCase() }).lean<BookingRecord>();
  const role = booking ? roleIn(booking, actor.userId) : 'STAFF';
  if (!booking || role === 'STAFF') throw new HttpError(404, 'NOT_FOUND', "We couldn't find that booking.");
  if (!INCIDENT_BOOKING_STATUSES.includes(booking.status)) {
    throw new HttpError(
      409,
      'NOT_REPORTABLE',
      'Incidents can be reported on confirmed trips. Contact support for anything else.',
    );
  }
  // Whatever it's filed as, damage found after the trip must come within the window (plan §3); staff can
  // still open a case after it (openIncidentAsStaff).
  if (WINDOW_TYPES.includes(input.type) && booking.status === 'COMPLETED') {
    const settings = await getPlatformSettings();
    const checkOut = await ConditionReportModel.findOne({ bookingId: booking._id, stage: 'CHECK_OUT' })
      .select('createdAt')
      .lean();
    const closes =
      (checkOut?.createdAt ?? booking.endAt).getTime() + settings.trips.damageReportWindowHours * HOUR_MS;
    if (now.getTime() > closes) {
      throw new HttpError(
        409,
        'DAMAGE_WINDOW_CLOSED',
        `${input.type === 'ACCIDENT' ? 'An accident' : TYPE_WORDS[input.type]} must be reported within ${settings.trips.damageReportWindowHours} hours of check-out, and that time has passed. Contact support if you need help.`,
        { type: `Report this within ${settings.trips.damageReportWindowHours} hours of check-out` },
      );
    }
  }
  const flagged = input.fromCheckOutDamage ? await unclaimedCheckOutDamage(booking) : undefined;
  const attachments = [
    ...(await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments)),
    ...(flagged?.attachments ?? []),
  ];
  const description = [input.description, flagged?.summary].filter(Boolean).join('\n\n').slice(0, 5000);

  const incident = await createCase({
    bookingId: booking._id,
    reporterId: new mongoose.Types.ObjectId(actor.userId),
    type: input.type,
    description,
    ...(flagged && { damagePinIds: flagged.pinIds }),
    attachments,
    visibility: 'BOTH',
    now,
  });

  // The booking's payouts wait until the case is settled (plan §8.1, item 9).
  await holdBookingPayouts(booking._id, 'INCIDENT');
  const reporter = await UserModel.findById(actor.userId).select('firstName').lean();
  await notify({
    userId: actor.userId,
    type: 'INCIDENT_OPENED',
    title: `Case ${incident.caseRef} is open`,
    body: 'Our support team will be in touch.',
    link: `/incidents/${incident.caseRef}`,
    email: {
      template: 'tripNotice',
      props: {
        firstName: reporter?.firstName ?? 'there',
        heading: `We've got your report: case ${incident.caseRef}`,
        paragraphs: [
          `Thanks for reporting the ${TYPE_WORDS[incident.type].toLowerCase()} on booking ${booking.ref}. Our support team will look into it and keep you updated on the case.`,
          'Add photos, receipts or anything else on the case page. In an emergency, call 111.',
        ],
        rows: [
          { label: 'Case', value: incident.caseRef },
          { label: 'Booking', value: booking.ref },
        ],
        buttonLabel: 'Open the case',
        url: `${siteUrl()}/incidents/${incident.caseRef}`,
      },
    },
    dedupeKey: `INCIDENT_OPENED:${incident._id.toString()}`,
  });
  await tellParties(incident, booking, incident.events[0]!, 0, `${TYPE_WORDS[incident.type]} reported`);
  await alertStaff({
    type: 'INCIDENT_OPENED',
    title: `New ${TYPE_WORDS[incident.type].toLowerCase()} case ${incident.caseRef}`,
    body: `${role === 'GUEST' ? 'the guest' : 'the host'} reported ${TYPE_WORDS[incident.type].toLowerCase()} on booking ${booking.ref}: ${description.slice(0, 200)}`,
    link: `/admin/incidents/${incident.caseRef}`,
    dedupeKey: `INCIDENT_OPENED:${incident._id.toString()}`,
  });
  return toView(incident, booking, role, actor.userId);
}

/**
 * POST /admin/incidents: support opens a case on a booking themselves (plan §3: staff can, outside the
 * damage-report window), for both parties, the one it's about, or the team only. Whoever opens it has it.
 * The booking's payouts are held as for any open case, and the parties who can see it are told.
 */
export async function openIncidentAsStaff(
  staffId: string,
  input: StaffNewIncidentInput,
  ip?: string,
  now = new Date(),
): Promise<IncidentView> {
  const booking = await BookingModel.findOne({ ref: input.bookingRef.toUpperCase() }).lean<BookingRecord>();
  // A checkout that was never paid isn't a booking anyone can have a case about.
  if (!booking || booking.status === 'PAYMENT_PENDING') {
    throw new HttpError(404, 'NOT_FOUND', "We couldn't find that booking.", {
      bookingRef: 'No booking has this reference',
    });
  }
  await assertNotOwnRecord(staffId, [booking.guestId, booking.hostId]);
  const attachments = await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments);
  const staff = new mongoose.Types.ObjectId(staffId);
  const incident = await createCase({
    bookingId: booking._id,
    reporterId: staff,
    type: input.type,
    description: input.description,
    attachments,
    visibility: input.visibility,
    assignedTo: staff,
    now,
  });

  // The booking's payouts wait until the case is settled (plan §8.1, item 9).
  await holdBookingPayouts(booking._id, 'INCIDENT');
  await recordAudit({
    actorId: staffId,
    action: 'incident.opened',
    entity: 'incident',
    entityId: incident._id.toString(),
    after: {
      caseRef: incident.caseRef,
      bookingRef: booking.ref,
      type: incident.type,
      visibility: input.visibility,
    },
    ...(ip && { ip }),
  });
  await tellParties(
    incident,
    booking,
    incident.events[0]!,
    0,
    `${TYPE_WORDS[incident.type]} case opened`,
    `Rento Vroom support has opened a ${TYPE_WORDS[incident.type].toLowerCase()} case about booking ${booking.ref}, the ${booking.vehicleSnapshot.title}. Follow it, and add photos or documents, on the case page.`,
  );
  return toView(incident, booking, 'STAFF', staffId);
}

/** GET /incidents: cases on the user's bookings, as Guest or Host, newest first. */
export async function listMyIncidents(userId: string) {
  const bookings = await BookingModel.find({ $or: [{ guestId: userId }, { hostId: userId }] })
    .select('_id ref guestId hostId vehicleSnapshot.title')
    .lean<BookingRecord[]>();
  const incidents = await IncidentModel.find({
    bookingId: mongoose.trusted({ $in: bookings.map((booking) => booking._id) }),
  })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean<IncidentRecord[]>();
  return incidents.flatMap((incident) => {
    const booking = bookings.find((candidate) => candidate._id.equals(incident.bookingId))!;
    // A case support opened for the other party, or the team only, isn't theirs to see.
    return caseVisibleTo(incident, roleIn(booking, userId)) ? [summary(incident, booking, userId)] : [];
  });
}

function summary(incident: IncidentRecord, booking: BookingRecord, viewerId: string) {
  const reporter = roleIn(booking, incident.reporterId);
  const role = roleIn(booking, viewerId);
  return {
    caseRef: incident.caseRef,
    bookingRef: booking.ref,
    vehicleTitle: booking.vehicleSnapshot.title,
    type: incident.type,
    status: incident.status,
    reportedBy: reporter === 'STAFF' ? ('SUPPORT' as const) : reporter,
    role,
    ...(role !== 'STAFF' && { awaitingYou: awaitsParty(incident, role) }),
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
  };
}

/** GET /incidents/{ref}: one case, with the events the viewer may see. */
export async function getIncident(actor: Actor, caseRef: string): Promise<IncidentView> {
  const { incident, booking, role } = await findCase(actor, caseRef);
  return toView(incident, booking, role, actor.userId);
}

async function appendEvent(
  incidentId: Id,
  event: IncidentEvent,
  set: Record<string, unknown> = {},
  unset: string[] = [],
  /** Only while the case still has this status: a status change someone else just made wins. */
  whileStatus?: IncidentStatus,
) {
  const updated = await IncidentModel.findOneAndUpdate(
    { _id: incidentId, ...(whileStatus && { status: whileStatus }) },
    {
      $push: { events: event },
      ...(Object.keys(set).length > 0 && { $set: set }),
      ...(unset.length > 0 && { $unset: Object.fromEntries(unset.map((field) => [field, 1])) }),
    },
    { new: true },
  ).lean<IncidentRecord>();
  if (!updated) {
    throw new HttpError(409, 'CASE_CHANGED', 'Someone else just changed this case. Refresh to see it.');
  }
  return updated;
}

/**
 * POST /incidents/{ref}/events: the Guest or Host adds to an open case. The other party sees it when they
 * see the case, unless it answers something support asked this party alone (replyVisibility).
 */
export async function replyToIncident(
  actor: Actor,
  caseRef: string,
  input: IncidentReplyInput,
  now = new Date(),
) {
  const { incident, booking, role } = await findCase(actor, caseRef);
  if (role === 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'Staff update cases from the staff portal.');
  if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(incident.status)) {
    throw new HttpError(
      409,
      'CASE_CLOSED',
      incident.status === 'RESOLVED'
        ? 'This case is resolved. Contact support to reopen it.'
        : 'This case is closed. Contact support about anything new.',
    );
  }
  const attachments = await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments);
  // Back with support once the party support asked has answered (a reply from the other side doesn't).
  const answersQuestion = awaitsParty(incident, role);
  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(actor.userId),
    action: 'COMMENT',
    ...(input.note && { note: input.note }),
    attachments,
    visibility: replyVisibility(incident, booking, role),
    ...(answersQuestion && { status: 'INVESTIGATING' as const }),
    createdAt: now,
  };
  // Only while the case is as the party saw it: one support resolved or closed meanwhile isn't reopened.
  const updated = await appendEvent(
    incident._id,
    event,
    answersQuestion ? { status: 'INVESTIGATING' } : {},
    [],
    incident.status,
  );
  await tellParties(updated, booking, event, updated.events.length - 1, 'New update');
  const title = `${role === 'GUEST' ? 'The guest' : 'The host'} added to case ${incident.caseRef}`;
  const staffLink = `/admin/incidents/${incident.caseRef}`;
  const dedupeKey = `INCIDENT_STAFF:${incident._id.toString()}:${updated.events.length - 1}`;
  if (incident.assignedTo && (await findActiveStaff(incident.assignedTo.toString()))) {
    await notify({
      userId: incident.assignedTo,
      type: 'INCIDENT_UPDATE',
      title,
      body: input.note?.slice(0, 160),
      link: staffLink,
      dedupeKey,
    });
  } else {
    // Nobody on the team has the case: the whole team hears, so the update doesn't wait unseen (plan §7).
    await alertStaff({
      type: 'INCIDENT_UPDATE',
      title,
      body: `${role === 'GUEST' ? 'the guest' : 'the host'} added to the ${TYPE_WORDS[incident.type].toLowerCase()} case on booking ${booking.ref}${
        input.note ? `: ${input.note.slice(0, 200)}` : ` (${plural(attachments.length, 'file')})`
      }`,
      link: staffLink,
      dedupeKey,
    });
  }
  return toView(updated, booking, role, actor.userId);
}

/** GET /admin/incidents: the support team's cases, open ones by default, last updated first, a page at a time. */
export async function listIncidentsForStaff({ status, page }: { status?: IncidentStatus; page: number }) {
  const filter = status ? { status } : { status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }) };
  const [incidents, total] = await Promise.all([
    IncidentModel.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * STAFF_INCIDENTS_PAGE_SIZE)
      .limit(STAFF_INCIDENTS_PAGE_SIZE)
      .lean<IncidentRecord[]>(),
    IncidentModel.countDocuments(filter),
  ]);
  const bookings = await BookingModel.find({
    _id: mongoose.trusted({ $in: incidents.map((incident) => incident.bookingId) }),
  })
    .select('_id ref guestId hostId vehicleSnapshot.title')
    .lean<BookingRecord[]>();
  const staff = await UserModel.find({
    _id: mongoose.trusted({
      $in: incidents.flatMap((incident) => (incident.assignedTo ? [incident.assignedTo] : [])),
    }),
  })
    .select('firstName')
    .lean();
  const rows = incidents.flatMap((incident) => {
    const booking = bookings.find((candidate) => candidate._id.equals(incident.bookingId));
    if (!booking) return [];
    const assigned = staff.find((member) => incident.assignedTo && member._id.equals(incident.assignedTo));
    return [
      {
        ...summary(incident, booking, ''),
        role: 'STAFF' as const,
        ...(assigned && { assignedTo: assigned.firstName }),
        ...(incident.assignedTo && { assignedToId: incident.assignedTo.toString() }),
      },
    ];
  });
  return { incidents: rows, total, page };
}

const isOpen = (status: IncidentStatus) => (OPEN_INCIDENT_STATUSES as readonly string[]).includes(status);
const statusWords = (status: IncidentStatus) => status.replace('_', ' ').toLowerCase();

/**
 * POST /admin/incidents/{ref}/events: support posts an update for both parties, one of them or the team
 * only (by default, whoever already sees the case), changes the status or takes the case (internal, with
 * nothing else). The status moves only as INCIDENT_TRANSITIONS allows (409
 * otherwise). Resolving or closing the last open case on a booking releases its payouts; reopening a
 * resolved case holds the unpaid ones again.
 */
export async function updateIncidentAsStaff(
  staffId: string,
  roles: Actor['roles'],
  caseRef: string,
  input: StaffIncidentUpdateInput,
  ip?: string,
  now = new Date(),
): Promise<IncidentView> {
  const { incident, booking } = await findCase({ userId: staffId, roles }, caseRef);
  await assertNotOwnRecord(staffId, [booking.guestId, booking.hostId]);
  const statusChanged = input.status && input.status !== incident.status;
  if (input.status && statusChanged && !INCIDENT_TRANSITIONS[incident.status].includes(input.status)) {
    throw new HttpError(
      409,
      'INVALID_STATUS_CHANGE',
      incident.status === 'CLOSED'
        ? 'This case is closed. Open a new case for anything new.'
        : `A ${statusWords(incident.status)} case can't be moved to ${statusWords(input.status)}.`,
    );
  }
  const attachments = await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments);
  // Taking the case is the team's business, as when it's handed over (assignIncident): never shared, and
  // nobody is told. Anything else goes to whoever already sees the case, unless staff choose otherwise.
  const assignOnly = Boolean(input.assignToMe) && !statusChanged && !input.note && attachments.length === 0;
  const visibility = assignOnly ? 'INTERNAL' : (input.visibility ?? caseAudience(incident));
  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(staffId),
    action: statusChanged ? 'STATUS' : assignOnly ? 'ASSIGNED' : 'COMMENT',
    ...(input.note && { note: input.note }),
    attachments,
    visibility,
    ...(statusChanged && { status: input.status }),
    ...(assignOnly && { assigneeId: new mongoose.Types.ObjectId(staffId) }),
    createdAt: now,
  };
  const updated = await appendEvent(
    incident._id,
    event,
    {
      ...(statusChanged && { status: input.status }),
      ...(input.assignToMe && { assignedTo: staffId }),
    },
    [],
    statusChanged ? incident.status : undefined,
  );
  await recordAudit({
    actorId: staffId,
    action: 'incident.updated',
    entity: 'incident',
    entityId: incident._id.toString(),
    before: { status: incident.status },
    after: {
      status: updated.status,
      visibility,
      ...(input.assignToMe && { assignedTo: staffId }),
    },
    ...(ip && { ip }),
  });

  if (!isOpen(updated.status)) {
    const stillOpen = await IncidentModel.exists({
      bookingId: booking._id,
      status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }),
    });
    if (!stillOpen) await releaseHeldPayouts({ bookingId: booking._id }, 'INCIDENT', { now });
  } else if (!isOpen(incident.status)) {
    // Reopened: payouts not yet sent wait for the case again (plan §8.1, item 9).
    await holdBookingPayouts(booking._id, 'INCIDENT');
  }
  if (visibility !== 'INTERNAL') {
    await tellParties(
      updated,
      booking,
      event,
      updated.events.length - 1,
      !statusChanged
        ? 'New update'
        : isOpen(updated.status) && !isOpen(incident.status)
          ? 'Case reopened'
          : `Case ${statusWords(updated.status)}`,
    );
  }
  return toView(updated, booking, 'STAFF', staffId);
}

/** GET /admin/incidents/assignees: who a case can be handed to, the admin first. */
export async function listIncidentAssignees(staffId: string): Promise<IncidentAssignees> {
  const staff = await listActiveStaff();
  return {
    assignees: staff.map((member) => ({
      id: member.id,
      name: `${member.firstName} ${member.lastName}`,
      you: member.id === staffId,
    })),
  };
}

/**
 * POST /admin/incidents/{ref}/assignee: support hands the case to a staff member (the admin or an active
 * support member), or to nobody. It's an internal event on the case and in the audit log, and whoever
 * gets the case is told. Choosing whoever has it already changes nothing.
 */
export async function assignIncident(
  staffId: string,
  roles: Actor['roles'],
  caseRef: string,
  input: IncidentAssigneeInput,
  ip?: string,
  now = new Date(),
): Promise<IncidentView> {
  const { incident, booking } = await findCase({ userId: staffId, roles }, caseRef);
  await assertNotOwnRecord(staffId, [booking.guestId, booking.hostId]);
  const assignee = input.userId ? await findActiveStaff(input.userId) : null;
  if (input.userId && !assignee) {
    throw new HttpError(409, 'NOT_STAFF', 'Choose someone on the support team.', {
      userId: 'Choose someone on the support team',
    });
  }
  // Nor can it go to a support member who is the Guest or Host on it: they couldn't act on it.
  if (assignee && (await isOwnRecord(assignee._id.toString(), [booking.guestId, booking.hostId]))) {
    throw new HttpError(409, 'OWN_RECORD', 'Choose someone else: this case is about their own booking.', {
      userId: 'This case is about their own booking',
    });
  }
  const unchanged = assignee ? incident.assignedTo?.equals(assignee._id) : !incident.assignedTo;
  if (unchanged) return toView(incident, booking, 'STAFF', staffId);

  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(staffId),
    action: assignee ? 'ASSIGNED' : 'UNASSIGNED',
    attachments: [],
    visibility: 'INTERNAL',
    ...(assignee && { assigneeId: assignee._id }),
    createdAt: now,
  };
  const updated = assignee
    ? await appendEvent(incident._id, event, { assignedTo: assignee._id })
    : await appendEvent(incident._id, event, {}, ['assignedTo']);
  await recordAudit({
    actorId: staffId,
    action: 'incident.assigned',
    entity: 'incident',
    entityId: incident._id.toString(),
    before: { assignedTo: incident.assignedTo?.toString() ?? null },
    after: { assignedTo: assignee?._id.toString() ?? null },
    ...(ip && { ip }),
  });
  if (assignee && !assignee._id.equals(staffId)) {
    const by = await UserModel.findById(staffId).select('firstName').lean();
    await notify({
      userId: assignee._id,
      type: 'INCIDENT_ASSIGNED',
      title: `Case ${incident.caseRef} is assigned to you`,
      body: `${by?.firstName ?? 'Support'} handed you the ${TYPE_WORDS[incident.type].toLowerCase()} case on booking ${booking.ref}.`,
      link: `/admin/incidents/${incident.caseRef}`,
      dedupeKey: `INCIDENT_ASSIGNED:${incident._id.toString()}:${updated.events.length - 1}`,
    });
  }
  return toView(updated, booking, 'STAFF', staffId);
}

/**
 * POST /admin/incidents/{ref}/charges: a resolved case adds an extra charge to the Guest (fuel, cleaning,
 * late return, damage, tolls or fines, where the Guest Agreement allows), charged to their saved card
 * (plan §8.1, item 11). On a damage, accident or theft case under a protection plan, the case's charges
 * stay within the plan's excess (plan §3). The form's idempotency key makes a repeated submit add nothing.
 */
export async function chargeFromIncident(
  staffId: string,
  roles: Actor['roles'],
  caseRef: string,
  input: IncidentChargeInput,
  ip?: string,
  now = new Date(),
): Promise<IncidentView> {
  const { incident, booking } = await findCase({ userId: staffId, roles }, caseRef);
  await assertNotOwnRecord(staffId, [booking.guestId, booking.hostId]);
  const key = input.idempotencyKey;
  // The same submit again (a double click, or a retry after a lost response): the charge is there already,
  // and its entry on the case too, unless the first try stopped before writing it.
  if (key && booking.extraCharges.some((charge) => charge.idempotencyKey === key)) {
    return chargeRecorded(staffId, incident, booking, input, ip, now);
  }
  if (incident.status !== 'RESOLVED') {
    throw new HttpError(409, 'NOT_RESOLVED', 'Resolve the case before adding a charge.');
  }
  const limit = chargeLimit(incident, booking, input.type);
  if (limit && input.amountCents > limit.remaining) throw overExcess(limit);
  let chargeId: string;
  try {
    // The charge and its collection are saved together: one saved without its job would never be collected.
    chargeId = await withTransaction((session) =>
      addExtraCharge(
        booking._id,
        {
          type: input.type as Booking['extraCharges'][number]['type'],
          description: input.description,
          amountCents: input.amountCents,
          incidentId: incident._id,
          addedBy: staffId,
          ...(key && { idempotencyKey: key }),
          // Checked again as it's added: another charge from the case may have gone in a moment ago.
          ...(limit && { capCents: limit.plan.excessCents, ...(limit.types && { capTypes: limit.types }) }),
        },
        session,
      ),
    );
  } catch (error) {
    // The same submit just added it, at the same moment.
    if (error instanceof HttpError && error.code === 'ALREADY_CHARGED') {
      return chargeRecorded(staffId, incident, booking, input, ip, now);
    }
    if (error instanceof HttpError && error.code === 'OVER_CAP') {
      const fresh = (await BookingModel.findById(booking._id).lean<BookingRecord>()) ?? booking;
      throw overExcess(chargeLimit(incident, fresh, input.type)!);
    }
    throw error;
  }
  return recordCharge(staffId, incident, booking, input, new mongoose.Types.ObjectId(chargeId), ip, now);
}

/** A charge the protection plan's excess has no room for (plan §8.1, item 11). */
function overExcess(limit: NonNullable<ReturnType<typeof chargeLimit>>) {
  const excess = formatNzdExact(limit.plan.excessCents);
  return new HttpError(
    409,
    'OVER_EXCESS',
    `The Guest’s ${limit.plan.name} limits what they pay for this case to its ${excess} excess${
      limit.charged > 0 ? `, and ${formatNzdExact(limit.charged)} is charged already` : ''
    }.`,
    {
      amountCents:
        limit.remaining > 0
          ? `Up to ${formatNzdExact(limit.remaining)}, within the protection plan’s ${excess} excess`
          : `Nothing more: the protection plan’s ${excess} excess is charged already`,
    },
  );
}

const chargeNote = (input: IncidentChargeInput) =>
  `A charge of $${(input.amountCents / 100).toFixed(2)} was added to the guest's booking: ${input.description}.`;

/**
 * A repeated submit: the case as it is, with the charge's entry on it. A first try that stopped after adding
 * the charge left none, so it's written now (recordCharge writes it once, however many submits get here).
 */
async function chargeRecorded(
  staffId: string,
  incident: IncidentRecord,
  booking: BookingRecord,
  input: IncidentChargeInput,
  ip: string | undefined,
  now: Date,
): Promise<IncidentView> {
  const fresh = (await BookingModel.findById(booking._id).lean<BookingRecord>()) ?? booking;
  const charge = fresh.extraCharges.find((candidate) => candidate.idempotencyKey === input.idempotencyKey);
  return recordCharge(staffId, incident, fresh, input, charge!._id!, ip, now);
}

/**
 * The charge's entry on the case, in the audit log, and told to whoever sees the case. Written once per
 * charge: a submit that finds the entry there already (written by the same submit sent twice) leaves it.
 */
async function recordCharge(
  staffId: string,
  incident: IncidentRecord,
  booking: BookingRecord,
  input: IncidentChargeInput,
  chargeId: Types.ObjectId,
  ip: string | undefined,
  now: Date,
): Promise<IncidentView> {
  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(staffId),
    action: 'CHARGE_ADDED',
    note: chargeNote(input),
    attachments: [],
    // On the case for whoever already sees it; the Guest hears of the charge itself with its receipt.
    visibility: caseAudience(incident),
    extraChargeId: chargeId,
    createdAt: now,
  };
  const updated = await IncidentModel.findOneAndUpdate(
    { _id: incident._id, 'events.extraChargeId': mongoose.trusted({ $ne: chargeId }) },
    { $push: { events: event } },
    { new: true },
  ).lean<IncidentRecord>();
  if (!updated) {
    const latest = (await IncidentModel.findById(incident._id).lean<IncidentRecord>()) ?? incident;
    const fresh = (await BookingModel.findById(booking._id).lean<BookingRecord>()) ?? booking;
    return toView(latest, fresh, 'STAFF', staffId);
  }
  await recordAudit({
    actorId: staffId,
    action: 'incident.charge-added',
    entity: 'incident',
    entityId: incident._id.toString(),
    after: { type: input.type, amountCents: input.amountCents },
    ...(ip && { ip }),
  });
  await tellParties(updated, booking, event, updated.events.length - 1, 'A charge was added');
  const fresh = await BookingModel.findById(booking._id).lean<BookingRecord>();
  return toView(updated, fresh!, 'STAFF', staffId);
}

/**
 * A case's charge cancelled or refunded, on the case's history for whoever sees the case, as its CHARGE_ADDED
 * entry is (spec §15: the case's complete audit trail). Inside the caller's transaction, if any.
 */
export async function recordCaseChargeChange(
  incidentId: Id,
  change: {
    action: 'CHARGE_CANCELLED' | 'CHARGE_REFUNDED';
    actorId?: Id | string;
    extraChargeId: Id;
    note: string;
    now?: Date;
  },
  session?: ClientSession,
): Promise<void> {
  const incident = await IncidentModel.findById(incidentId)
    .select('events.visibility')
    .session(session ?? null)
    .lean<Pick<Incident, 'events'>>();
  if (!incident) return;
  const event: IncidentEvent = {
    ...(change.actorId && { actorId: new mongoose.Types.ObjectId(String(change.actorId)) }),
    action: change.action,
    note: change.note,
    attachments: [],
    visibility: caseAudience(incident),
    extraChargeId: change.extraChargeId,
    createdAt: change.now ?? new Date(),
  };
  await IncidentModel.updateOne({ _id: incidentId }, { $push: { events: event } }, { session });
}
