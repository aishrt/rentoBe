import mongoose, { type Types } from 'mongoose';
import { env } from '../../env.js';
import { enqueue } from '../../jobs/queue.js';
import { formatNzDate } from '../../lib/format.js';
import { nextNzHour, nzDate } from '../../lib/nz-time.js';
import { BookingModel } from '../bookings/booking.model.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { notify } from '../notifications/notify.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel, type MaintenanceReminder, type Vehicle } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import type { MaintenanceInput } from './host-reminders.schemas.js';

/*
 * What a Host has to do (spec §9; plan §4.3 `daily.hostReminders`, §8.2): the dashboard's to-do list, and
 * the 9 am reminders for WOF, CoF, rego and insurance 30 and 7 days before they expire, the Road User
 * Charges licence running out, maintenance the Host set, and cars whose documents run out before a booked
 * trip ends.
 */

type Id = Types.ObjectId;
type VehicleRecord = Vehicle & { _id: Id };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reminders go out at 9 am NZ time (plan §4.3). */
export const HOST_REMINDER_HOUR = 9;
/** A Road User Charges licence this close to its end reading is flagged. */
const RUC_WARNING_KM = 1000;
/** Support steps in when a car's documents are still out of date this close to a booked trip. */
const DOCUMENT_ALERT_HOURS = 72;

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

export interface TodoItem {
  kind:
    | 'PAYOUT_SETUP'
    | 'REQUESTS'
    | 'CHECK_IN'
    | 'CONFIRM_HANDOVER'
    | 'DOCUMENT_EXPIRING'
    | 'RUC'
    | 'MAINTENANCE'
    | 'LISTING_CHANGES';
  title: string;
  detail?: string;
  link: string;
  urgent: boolean;
}

interface ExpiringDocument {
  label: string;
  expiry: Date;
}

/** The car's dated documents: WOF or CoF, rego, and the latest verified insurance. */
function datedDocuments(vehicle: VehicleRecord): ExpiringDocument[] {
  const insurance = vehicle.documents
    .filter((document) => document.type === 'INSURANCE' && document.status !== 'REJECTED' && document.expiry)
    .sort((a, b) => b.expiry!.getTime() - a.expiry!.getTime())[0];
  return [
    ...(vehicle.wofExpiry ? [{ label: 'WOF', expiry: vehicle.wofExpiry }] : []),
    ...(vehicle.cofExpiry ? [{ label: 'CoF', expiry: vehicle.cofExpiry }] : []),
    ...(vehicle.regoExpiry ? [{ label: 'Rego', expiry: vehicle.regoExpiry }] : []),
    ...(insurance ? [{ label: 'Insurance', expiry: insurance.expiry! }] : []),
  ];
}

/** The car's latest odometer reading, from its last check-in or check-out. */
async function latestOdometer(vehicleId: Id): Promise<number | null> {
  const bookings = await BookingModel.find({ vehicleId }).select('_id').lean();
  if (bookings.length === 0) return null;
  const report = await ConditionReportModel.findOne({
    bookingId: mongoose.trusted({ $in: bookings.map((booking) => booking._id) }),
  })
    .sort({ createdAt: -1 })
    .select('odometer')
    .lean();
  return report?.odometer ?? null;
}

/** Maintenance reminders that are due: by date, or by the odometer. */
function dueMaintenance(vehicle: VehicleRecord, odometer: number | null, now: Date): MaintenanceReminder[] {
  return vehicle.maintenanceReminders.filter(
    (reminder) =>
      !reminder.doneAt &&
      ((reminder.dueAt && reminder.dueAt.getTime() - now.getTime() <= 7 * DAY_MS) ||
        (reminder.dueOdometer !== undefined && odometer !== null && odometer >= reminder.dueOdometer - 500)),
  );
}

/** GET /host/todo: the Host's to-do list, most urgent first. */
export async function hostTodo(hostId: string, now = new Date()): Promise<TodoItem[]> {
  const host = await UserModel.findById(hostId).select('hostProfile').lean();
  if (!host?.hostProfile) return [];
  const items: TodoItem[] = [];

  if (host.hostProfile.status === 'APPROVED' && !host.hostProfile.payoutsEnabled) {
    const waiting = await VehicleModel.countDocuments({ hostId, payoutsReady: false });
    const held = await PayoutModel.countDocuments({ hostId, status: 'HELD', holdReason: 'PAYOUT_SETUP' });
    items.push({
      kind: 'PAYOUT_SETUP',
      title: 'Set up payouts',
      detail:
        waiting > 0
          ? `${waiting === 1 ? 'An approved listing goes' : `${waiting} approved listings go`} live once it’s done.`
          : held > 0
            ? 'Your earnings are waiting for it.'
            : 'So we can pay you after each trip.',
      link: '/host/earnings',
      urgent: waiting > 0 || held > 0,
    });
  }

  const requests = await BookingModel.countDocuments({
    hostId,
    status: 'PENDING',
    instantBook: false,
    hostAcceptedAt: mongoose.trusted({ $exists: false }),
    requestExpiresAt: mongoose.trusted({ $gt: now }),
  });
  if (requests > 0) {
    items.push({
      kind: 'REQUESTS',
      title: requests === 1 ? 'A booking request to answer' : `${requests} booking requests to answer`,
      detail: 'Requests expire after 24 hours.',
      link: '/host/bookings',
      urgent: true,
    });
  }

  const soon = await BookingModel.find({
    hostId,
    status: 'CONFIRMED',
    startAt: mongoose.trusted({ $lte: new Date(now.getTime() + DAY_MS) }),
  })
    .select('ref startAt vehicleSnapshot.title')
    .sort({ startAt: 1 })
    .lean();
  for (const booking of soon) {
    items.push({
      kind: 'CHECK_IN',
      title: `Check-in for ${booking.vehicleSnapshot.title}`,
      detail: `${booking.startAt <= now ? 'Started' : 'Starts'} ${formatNzDate(booking.startAt)}, ${booking.ref}.`,
      link: `/host/bookings/${booking.ref}`,
      urgent: booking.startAt <= now,
    });
  }

  const recent = await BookingModel.find({
    hostId,
    status: mongoose.trusted({ $in: ['ACTIVE', 'COMPLETED'] }),
  })
    .sort({ endAt: -1 })
    .limit(20)
    .select('_id ref vehicleSnapshot.title')
    .lean();
  const unconfirmed = await ConditionReportModel.find({
    bookingId: mongoose.trusted({ $in: recent.map((booking) => booking._id) }),
    confirmedByHostAt: mongoose.trusted({ $exists: false }),
  })
    .select('bookingId stage')
    .lean();
  for (const report of unconfirmed) {
    const booking = recent.find((candidate) => candidate._id.equals(report.bookingId))!;
    items.push({
      kind: 'CONFIRM_HANDOVER',
      title: `Confirm the ${report.stage === 'CHECK_IN' ? 'check-in' : 'check-out'} for ${booking.ref}`,
      detail: 'Check the photos and readings the guest took.',
      link: `/host/bookings/${booking.ref}/handover`,
      urgent: false,
    });
  }

  const vehicles = await VehicleModel.find({
    hostId,
    status: mongoose.trusted({ $in: ['ACTIVE', 'INACTIVE', 'UNDER_REVIEW', 'CHANGES_REQUESTED'] }),
  }).lean<VehicleRecord[]>();
  for (const vehicle of vehicles) {
    const title = vehicleTitle(vehicle);
    if (vehicle.status === 'CHANGES_REQUESTED') {
      items.push({
        kind: 'LISTING_CHANGES',
        title: `Update your ${title}`,
        detail: vehicle.reviewNotes ?? 'Our team asked for changes.',
        link: `/host/vehicles/${vehicle._id.toString()}`,
        urgent: false,
      });
    }
    for (const document of datedDocuments(vehicle)) {
      const days = Math.floor((document.expiry.getTime() - now.getTime()) / DAY_MS);
      if (days > 30) continue;
      items.push({
        kind: 'DOCUMENT_EXPIRING',
        title:
          days < 0 ? `${title}: ${document.label} has expired` : `${title}: ${document.label} expires soon`,
        detail: `${days < 0 ? 'Expired' : 'Expires'} ${formatNzDate(document.expiry)}. Upload the renewal to keep the car bookable.`,
        link: `/host/vehicles/${vehicle._id.toString()}/2`,
        urgent: days <= 7,
      });
    }
    const odometer = await latestOdometer(vehicle._id);
    if (
      vehicle.rucValidToKm !== undefined &&
      odometer !== null &&
      vehicle.rucValidToKm - odometer <= RUC_WARNING_KM
    ) {
      items.push({
        kind: 'RUC',
        title: `${title}: Road User Charges running out`,
        detail: `The licence runs to ${vehicle.rucValidToKm.toLocaleString('en-NZ')} km; the car was last at ${odometer.toLocaleString('en-NZ')} km.`,
        link: `/host/vehicles/${vehicle._id.toString()}/1`,
        urgent: vehicle.rucValidToKm <= odometer,
      });
    }
    for (const reminder of dueMaintenance(vehicle, odometer, now)) {
      items.push({
        kind: 'MAINTENANCE',
        title: `${title}: ${reminder.title}`,
        detail: reminder.dueAt
          ? `Due ${formatNzDate(reminder.dueAt)}.`
          : `Due at ${reminder.dueOdometer!.toLocaleString('en-NZ')} km.`,
        link: `/host/vehicles/${vehicle._id.toString()}/maintenance`,
        urgent: false,
      });
    }
  }
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

/** Queues tomorrow's 9 am run. The dated key means every instance queues it only once. */
export async function scheduleHostReminders(now = new Date()) {
  const runAt = nextNzHour(now, HOST_REMINDER_HOUR);
  await enqueue('daily.hostReminders', {}, { runAt, uniqueKey: `daily.hostReminders:${nzDate(runAt)}` });
}

/**
 * `daily.hostReminders` (plan §4.3): document, RUC and maintenance reminders, and booked trips whose car
 * won't have a current WOF, CoF or rego when the trip ends (plan §8.2). Each reminder is sent once.
 */
export async function runHostReminders(now = new Date()): Promise<number> {
  await scheduleHostReminders(now);
  let sent = 0;
  const vehicles = await VehicleModel.find({
    status: mongoose.trusted({ $in: ['ACTIVE', 'INACTIVE'] }),
  }).lean<VehicleRecord[]>();

  for (const vehicle of vehicles) {
    const title = vehicleTitle(vehicle);
    const host = await UserModel.findById(vehicle.hostId).select('firstName closedAt').lean();
    if (!host || host.closedAt) continue;
    const editUrl = `${siteUrl()}/host/vehicles/${vehicle._id.toString()}/2`;

    for (const document of datedDocuments(vehicle)) {
      const days = Math.floor((document.expiry.getTime() - now.getTime()) / DAY_MS);
      const stage = days < 0 ? null : days <= 7 ? 7 : days <= 30 ? 30 : null;
      if (stage === null) continue;
      await notify({
        userId: vehicle.hostId,
        type: 'DOCUMENT_EXPIRING',
        title: `${title}: ${document.label} expires ${formatNzDate(document.expiry)}`,
        body: 'Upload the renewal so the car stays bookable.',
        link: `/host/vehicles/${vehicle._id.toString()}/2`,
        email: {
          template: 'tripNotice',
          props: {
            firstName: host.firstName,
            heading: `Your ${title}'s ${document.label} expires in ${days} ${days === 1 ? 'day' : 'days'}`,
            paragraphs: [
              `The ${document.label} for your ${title} expires on ${formatNzDate(document.expiry)}.`,
              'Once it’s renewed, upload the new one. Guests can’t book trips that end after it expires, and a booked trip may have to be cancelled.',
            ],
            buttonLabel: 'Upload the renewal',
            url: editUrl,
          },
        },
        dedupeKey: `DOCUMENT_EXPIRING:${vehicle._id.toString()}:${document.label}:${nzDate(document.expiry)}:${stage}`,
      });
      sent += 1;
    }

    const odometer = await latestOdometer(vehicle._id);
    if (
      vehicle.rucValidToKm !== undefined &&
      odometer !== null &&
      vehicle.rucValidToKm - odometer <= RUC_WARNING_KM
    ) {
      await notify({
        userId: vehicle.hostId,
        type: 'RUC_RUNNING_OUT',
        title: `${title}: Road User Charges running out`,
        body: `The licence runs to ${vehicle.rucValidToKm.toLocaleString('en-NZ')} km; the car was last at ${odometer.toLocaleString('en-NZ')} km.`,
        link: `/host/vehicles/${vehicle._id.toString()}`,
        dedupeKey: `RUC_RUNNING_OUT:${vehicle._id.toString()}:${vehicle.rucValidToKm}`,
      });
      sent += 1;
    }

    for (const reminder of dueMaintenance(vehicle, odometer, now)) {
      await notify({
        userId: vehicle.hostId,
        type: 'MAINTENANCE_DUE',
        title: `${title}: ${reminder.title}`,
        body: reminder.dueAt ? `Due ${formatNzDate(reminder.dueAt)}.` : `Due at ${reminder.dueOdometer} km.`,
        link: `/host/vehicles/${vehicle._id.toString()}/maintenance`,
        email: {
          template: 'tripNotice',
          props: {
            firstName: host.firstName,
            heading: `Maintenance due: ${reminder.title}`,
            paragraphs: [
              `You asked us to remind you: ${reminder.title} for your ${title} is due${reminder.dueAt ? ` on ${formatNzDate(reminder.dueAt)}` : ` at ${reminder.dueOdometer?.toLocaleString('en-NZ')} km`}.`,
              ...(reminder.notes ? [reminder.notes] : []),
            ],
            buttonLabel: 'Mark it done',
            url: `${siteUrl()}/host/vehicles/${vehicle._id.toString()}/maintenance`,
          },
        },
        dedupeKey: `MAINTENANCE_DUE:${reminder._id?.toString() ?? reminder.title}`,
      });
      sent += 1;
    }
  }

  // Booked trips that would end after the car's WOF, CoF or rego runs out (plan §8.2).
  const booked = await BookingModel.find({
    status: 'CONFIRMED',
    startAt: mongoose.trusted({ $gt: now }),
  }).lean();
  for (const booking of booked) {
    const vehicle = vehicles.find((candidate) => candidate._id.equals(booking.vehicleId));
    if (!vehicle) continue;
    const short = datedDocuments(vehicle).filter(
      (document) => document.label !== 'Insurance' && document.expiry < booking.endAt,
    );
    if (short.length === 0) continue;
    const labels = short.map((document) => document.label).join(' and ');
    await notify({
      userId: booking.hostId,
      type: 'DOCUMENT_BEFORE_TRIP',
      title: `${labels} runs out before ${booking.ref} ends`,
      body: `Upload the renewal before ${formatNzDate(booking.startAt)} so the trip can go ahead.`,
      link: `/host/vehicles/${vehicle._id.toString()}/2`,
      email: {
        template: 'tripNotice',
        props: {
          firstName:
            (await UserModel.findById(booking.hostId).select('firstName').lean())?.firstName ?? 'there',
          heading: `Your car's ${labels} runs out before a booked trip ends`,
          paragraphs: [
            `Booking ${booking.ref} runs until ${formatNzDate(booking.endAt)}, but the ${labels} for your ${booking.vehicleSnapshot.title} expires before then.`,
            `Please renew it and upload the new one. If it’s still missing ${DOCUMENT_ALERT_HOURS} hours before the trip, our support team will contact you both.`,
          ],
          buttonLabel: 'Upload the renewal',
          url: `${siteUrl()}/host/vehicles/${vehicle._id.toString()}/2`,
        },
      },
      dedupeKey: `DOCUMENT_BEFORE_TRIP:${booking._id.toString()}:${labels}`,
    });
    if (booking.startAt.getTime() - now.getTime() <= DOCUMENT_ALERT_HOURS * 60 * 60 * 1000) {
      await alertStaff({
        type: 'DOCUMENT_BEFORE_TRIP',
        title: `${booking.ref}: the car's ${labels} runs out during the trip`,
        body: `booking ${booking.ref} starts ${formatNzDate(booking.startAt)} and the car's ${labels} expires before it ends. Contact both parties; it can be cancelled as a Host cancellation.`,
        link: `/admin/bookings/${booking.ref}`,
        dedupeKey: `DOCUMENT_BEFORE_TRIP:${booking._id.toString()}`,
      });
    }
    sent += 1;
  }
  return sent;
}

const maintenanceView = async (vehicle: VehicleRecord) => ({
  reminders: vehicle.maintenanceReminders.map((reminder) => ({
    id: reminder._id!.toString(),
    title: reminder.title,
    ...(reminder.dueAt && { dueAt: nzDate(reminder.dueAt) }),
    ...(reminder.dueOdometer !== undefined && { dueOdometer: reminder.dueOdometer }),
    ...(reminder.notes && { notes: reminder.notes }),
    ...(reminder.doneAt && { doneAt: reminder.doneAt.toISOString() }),
  })),
  latestOdometer: await latestOdometer(vehicle._id),
});

/** GET /host/vehicles/{id}/maintenance-reminders. */
export async function getMaintenance(vehicle: VehicleRecord) {
  return maintenanceView(vehicle);
}

/** PUT /host/vehicles/{id}/maintenance-reminders: the car's whole list, as the Host left it. */
export async function saveMaintenance(vehicleId: Id, input: MaintenanceInput, now = new Date()) {
  const current = await VehicleModel.findById(vehicleId).lean<VehicleRecord>();
  const reminders = input.reminders.map((reminder) => {
    const before = current?.maintenanceReminders.find((existing) => existing._id?.toString() === reminder.id);
    return {
      ...(before?._id && { _id: before._id }),
      title: reminder.title,
      ...(reminder.dueAt && { dueAt: new Date(`${reminder.dueAt}T09:00:00+12:00`) }),
      ...(reminder.dueOdometer !== undefined && { dueOdometer: reminder.dueOdometer }),
      ...(reminder.notes && { notes: reminder.notes }),
      ...(reminder.done && { doneAt: before?.doneAt ?? now }),
    };
  });
  const updated = await VehicleModel.findByIdAndUpdate(
    vehicleId,
    { $set: { maintenanceReminders: reminders } },
    { new: true, runValidators: true },
  ).lean<VehicleRecord>();
  return maintenanceView(updated!);
}
