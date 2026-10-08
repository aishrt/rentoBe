import mongoose, { type Types } from 'mongoose';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import type { FileAttachment } from '../../lib/model-fields.js';
import { randomRef } from '../../lib/refs.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type Booking } from '../bookings/booking.model.js';
import type { Actor } from '../bookings/booking.service.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { notify } from '../notifications/notify.js';
import { addExtraCharge } from '../payments/extra-charges.service.js';
import { holdBookingPayouts, releaseHeldPayouts } from '../payouts/payouts.service.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { findActiveStaff, listActiveStaff } from '../staff/staff.service.js';
import { attachmentView, confirmBookingFiles } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import { isStaff } from '../users/user.service.js';
import {
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
} from './incidents.schemas.js';

/*
 * Damage and incident reporting (spec §15; plan §8.2, §9 Days 20–21). The booking's Guest or Host reports
 * what happened, with photos and documents, and gets a case number. Support staff take the case, post
 * updates for both parties, one of them or the team only, and move it through its statuses; every event is
 * kept, append-only. While a case is open the booking's payouts are held and its messages stay open.
 * Resolving one can add an extra charge to the Guest, linked to the case.
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
    description: incident.description,
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
    extraCharges: booking.extraCharges
      .filter((charge) => charge.incidentId?.equals(incident._id))
      .map((charge) => ({
        type: charge.type,
        description: charge.description,
        amountCents: charge.amountCents,
        status: charge.status,
      })),
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
  return { incident, booking, role };
}

/** Tells the booking's parties who can see the event, except whoever made it. */
async function tellParties(
  incident: IncidentRecord,
  booking: BookingRecord,
  event: IncidentEvent,
  index: number,
  heading: string,
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
  if (input.type === 'DAMAGE' && booking.status === 'COMPLETED') {
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
        `Damage must be reported within ${settings.trips.damageReportWindowHours} hours of check-out. Contact support if you need help.`,
      );
    }
  }
  const flagged = input.fromCheckOutDamage ? await unclaimedCheckOutDamage(booking) : undefined;
  const attachments = [
    ...(await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments)),
    ...(flagged?.attachments ?? []),
  ];
  const description = [input.description, flagged?.summary].filter(Boolean).join('\n\n').slice(0, 5000);

  let incident: IncidentRecord | null = null;
  for (let attempt = 0; !incident; attempt += 1) {
    try {
      const created = await IncidentModel.create({
        caseRef: randomRef('IN'),
        bookingId: booking._id,
        reporterId: actor.userId,
        type: input.type,
        description,
        status: 'OPEN',
        ...(flagged && { damagePinIds: flagged.pinIds }),
        events: [
          {
            actorId: actor.userId,
            action: 'OPENED',
            note: description,
            attachments,
            visibility: 'BOTH',
            status: 'OPEN',
            createdAt: now,
          },
        ],
      });
      incident = created.toObject() as IncidentRecord;
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError && error.code === 11000) || attempt >= 3)
        throw error;
    }
  }

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
  return incidents.map((incident) =>
    summary(
      incident,
      bookings.find((booking) => booking._id.equals(incident.bookingId))!,
      userId,
    ),
  );
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
) {
  const updated = await IncidentModel.findOneAndUpdate(
    { _id: incidentId },
    {
      $push: { events: event },
      ...(Object.keys(set).length > 0 && { $set: set }),
      ...(unset.length > 0 && { $unset: Object.fromEntries(unset.map((field) => [field, 1])) }),
    },
    { new: true },
  ).lean<IncidentRecord>();
  return updated!;
}

/** POST /incidents/{ref}/events: the Guest or Host adds to an open case; both parties see it. */
export async function replyToIncident(
  actor: Actor,
  caseRef: string,
  input: IncidentReplyInput,
  now = new Date(),
) {
  const { incident, booking, role } = await findCase(actor, caseRef);
  if (role === 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'Staff update cases from the staff portal.');
  if (!(OPEN_INCIDENT_STATUSES as readonly string[]).includes(incident.status)) {
    throw new HttpError(409, 'CASE_CLOSED', 'This case is closed. Contact support to reopen it.');
  }
  const attachments = await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments);
  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(actor.userId),
    action: 'COMMENT',
    ...(input.note && { note: input.note }),
    attachments,
    visibility: 'BOTH',
    createdAt: now,
  };
  // Back with support once a party has answered what they were asked.
  const updated = await appendEvent(
    incident._id,
    event,
    incident.status === 'AWAITING_RESPONSE' ? { status: 'INVESTIGATING' } : {},
  );
  await tellParties(updated, booking, event, updated.events.length - 1, 'New update');
  if (incident.assignedTo) {
    await notify({
      userId: incident.assignedTo,
      type: 'INCIDENT_UPDATE',
      title: `${role === 'GUEST' ? 'The guest' : 'The host'} added to case ${incident.caseRef}`,
      body: input.note?.slice(0, 160),
      link: `/admin/incidents/${incident.caseRef}`,
      dedupeKey: `INCIDENT_STAFF:${incident._id.toString()}:${updated.events.length - 1}`,
    });
  }
  return toView(updated, booking, role, actor.userId);
}

/** GET /admin/incidents: the support team's cases, open ones first by default. */
export async function listIncidentsForStaff(status?: IncidentStatus) {
  const incidents = await IncidentModel.find(
    status ? { status } : { status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }) },
  )
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean<IncidentRecord[]>();
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
  return incidents.flatMap((incident) => {
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
}

/**
 * POST /admin/incidents/{ref}/events: support posts an update for both parties, one of them or the team
 * only, changes the status or takes the case. Resolving or closing the last open case on a booking
 * releases its payouts.
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
  const attachments = await confirmBookingFiles('INCIDENT_FILE', booking._id.toString(), input.attachments);
  const statusChanged = input.status && input.status !== incident.status;
  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(staffId),
    action: statusChanged ? 'STATUS' : input.assignToMe && !input.note ? 'ASSIGNED' : 'COMMENT',
    ...(input.note && { note: input.note }),
    attachments,
    visibility: input.visibility,
    ...(statusChanged && { status: input.status }),
    createdAt: now,
  };
  const updated = await appendEvent(incident._id, event, {
    ...(statusChanged && { status: input.status }),
    ...(input.assignToMe && { assignedTo: staffId }),
  });
  await recordAudit({
    actorId: staffId,
    action: 'incident.updated',
    entity: 'incident',
    entityId: incident._id.toString(),
    before: { status: incident.status },
    after: {
      status: updated.status,
      visibility: input.visibility,
      ...(input.assignToMe && { assignedTo: staffId }),
    },
    ...(ip && { ip }),
  });

  const nowClosed = !(OPEN_INCIDENT_STATUSES as readonly string[]).includes(updated.status);
  if (nowClosed) {
    const stillOpen = await IncidentModel.exists({
      bookingId: booking._id,
      status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }),
    });
    if (!stillOpen) await releaseHeldPayouts({ bookingId: booking._id }, 'INCIDENT', { now });
  }
  if (input.visibility !== 'INTERNAL') {
    await tellParties(
      updated,
      booking,
      event,
      updated.events.length - 1,
      statusChanged ? `Case ${updated.status.replace('_', ' ').toLowerCase()}` : 'New update',
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
  const assignee = input.userId ? await findActiveStaff(input.userId) : null;
  if (input.userId && !assignee) {
    throw new HttpError(409, 'NOT_STAFF', 'Choose someone on the support team.', {
      userId: 'Choose someone on the support team',
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
 * (plan §8.1, item 11).
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
  if (incident.status !== 'RESOLVED') {
    throw new HttpError(409, 'NOT_RESOLVED', 'Resolve the case before adding a charge.');
  }
  await addExtraCharge(booking._id, {
    type: input.type as Booking['extraCharges'][number]['type'],
    description: input.description,
    amountCents: input.amountCents,
    incidentId: incident._id,
    addedBy: staffId,
  });
  const event: IncidentEvent = {
    actorId: new mongoose.Types.ObjectId(staffId),
    action: 'CHARGE_ADDED',
    note: `A charge of $${(input.amountCents / 100).toFixed(2)} was added to the guest's booking: ${input.description}.`,
    attachments: [],
    visibility: 'BOTH',
    createdAt: now,
  };
  const updated = await appendEvent(incident._id, event);
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
