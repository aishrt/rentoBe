import mongoose, { type ClientSession, type Types } from 'mongoose';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { formatNzDateTime } from '../../lib/format.js';
import { nzTripDays } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type Booking, type BookingDocument } from '../bookings/booking.model.js';
import { completeTrip, startTrip } from '../bookings/booking-transitions.js';
import type { Viewer } from '../bookings/booking-view.js';
import { afterTripCompleted } from '../bookings/trip-completion.js';
import { postSystemMessage } from '../messages/thread-core.js';
import { releaseHeldPayouts } from '../payouts/payouts.service.js';
import { notify } from '../notifications/notify.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { getStorage, fileLink } from '../../integrations/storage/storage.js';
import { bookingUploadFolder } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import {
  ConditionReportModel,
  REQUIRED_INSPECTION_ANGLES,
  type ConditionReport,
  type InspectionStage,
} from './condition-report.model.js';
import type {
  ConditionReportView,
  FlagDamageInput,
  HandoverView,
  InspectionInput,
} from './inspections.schemas.js';

/*
 * The digital vehicle handover (spec §14, plan §8.2 and §9 Days 19–21). Check-in, by the Host with the
 * Guest or by the Guest alone, starts the trip; check-out ends it. Each is a set of timestamped photos of
 * every angle, the odometer, the fuel or battery level and any damage pinned on a car diagram, which the
 * other party reviews and confirms. Either party can flag new damage at check-out and afterwards, until the
 * damage-report window closes.
 */

type Id = Types.ObjectId;
type ReportRecord = ConditionReport & { _id: Id };
type BookingRecord = Booking & { _id: Id };

const HOUR_MS = 60 * 60 * 1000;
/** Check-in opens this long before the start time (plan §3, validation rules: inspections). */
export const CHECK_IN_OPENS_HOURS = 2;
/** A fuel or charge reading this many points short of what the policy asks is flagged. */
const FUEL_TOLERANCE_PCT = 5;

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const handoverPath = (booking: Pick<Booking, 'ref'>, role: 'GUEST' | 'HOST') =>
  role === 'GUEST' ? `/trips/${booking.ref}/handover` : `/host/bookings/${booking.ref}/handover`;

function partyOf(booking: Pick<Booking, 'guestId' | 'hostId'>, userId: Id | string | undefined) {
  if (!userId) return 'STAFF' as const;
  if (booking.guestId.equals(userId)) return 'GUEST' as const;
  if (booking.hostId.equals(userId)) return 'HOST' as const;
  return 'STAFF' as const;
}

/** A report as the Guest, the Host or staff see it; only staff see where each photo was taken. */
function toReportView(booking: BookingRecord, report: ReportRecord, viewer: Viewer): ConditionReportView {
  return {
    stage: report.stage,
    odometer: report.odometer,
    fuelOrBatteryPct: report.fuelOrBatteryPct,
    ...(report.notes && { notes: report.notes }),
    submittedBy: report.completedBy ? 'STAFF' : partyOf(booking, report.submittedBy),
    submittedAt: report.createdAt.toISOString(),
    photos: report.photos.map((photo) => ({
      angle: photo.angle,
      url: fileLink(photo.url),
      takenBy: partyOf(booking, photo.takenBy),
      takenAt: photo.takenAt.toISOString(),
      ...(photo.exifTakenAt && { exifTakenAt: photo.exifTakenAt.toISOString() }),
      uploadedAt: photo.uploadedAt.toISOString(),
      // Where someone stood is evidence for support in a dispute, not something the other party needs.
      ...(viewer === 'STAFF' &&
        photo.lat !== undefined &&
        photo.lng !== undefined && { lat: photo.lat, lng: photo.lng }),
    })),
    damagePins: report.damagePins.map((pin) => ({
      id: pin._id?.toString() ?? `${pin.x}-${pin.y}`,
      x: pin.x,
      y: pin.y,
      ...(pin.note && { note: pin.note }),
      newDamage: pin.newDamage,
      ...(pin.flaggedBy && { flaggedBy: partyOf(booking, pin.flaggedBy) }),
      ...(pin.flaggedAt && { flaggedAt: pin.flaggedAt.toISOString() }),
    })),
    ...(report.confirmedByGuestAt && { confirmedByGuestAt: report.confirmedByGuestAt.toISOString() }),
    ...(report.confirmedByHostAt && { confirmedByHostAt: report.confirmedByHostAt.toISOString() }),
    completedBySupport: Boolean(report.completedBy),
  };
}

/** Kilometres driven against the booking's allowance, and what the extra costs (plan §5). */
export function kilometresFor(
  booking: Pick<Booking, 'startAt' | 'endAt' | 'terms'>,
  checkIn: Pick<ConditionReport, 'odometer'>,
  checkOut: Pick<ConditionReport, 'odometer'>,
) {
  const driven = Math.max(0, checkOut.odometer - checkIn.odometer);
  if (booking.terms.unlimitedKm || booking.terms.kmAllowancePerDay === undefined) {
    return { driven, allowance: null, extra: 0, extraChargeCents: 0 };
  }
  const allowance = booking.terms.kmAllowancePerDay * nzTripDays(booking.startAt, booking.endAt);
  const extra = Math.max(0, driven - allowance);
  return { driven, allowance, extra, extraChargeCents: extra * booking.terms.extraKmCents };
}

/** Returned with less fuel or charge than the booking's fuel policy asks. */
function fuelShort(booking: Pick<Booking, 'terms'>, checkIn?: ReportRecord, checkOut?: ReportRecord) {
  if (!checkIn || !checkOut) return false;
  const wanted = booking.terms.fuelPolicy === 'FULL' ? 100 : checkIn.fuelOrBatteryPct;
  return checkOut.fuelOrBatteryPct < wanted - FUEL_TOLERANCE_PCT;
}

async function reportsFor(bookingId: Id) {
  const reports = await ConditionReportModel.find({ bookingId }).lean<ReportRecord[]>();
  return {
    checkIn: reports.find((report) => report.stage === 'CHECK_IN'),
    checkOut: reports.find((report) => report.stage === 'CHECK_OUT'),
  };
}

const confirmedBy = (report: ReportRecord | undefined, role: 'GUEST' | 'HOST') =>
  Boolean(role === 'GUEST' ? report?.confirmedByGuestAt : report?.confirmedByHostAt);

/** GET /bookings/{id}/inspections: both reports so far, and what this person can do next. */
export async function getHandover(
  booking: BookingDocument,
  viewer: Viewer,
  now = new Date(),
): Promise<HandoverView> {
  const record = booking.toObject() as BookingRecord;
  const settings = await getPlatformSettings();
  const [{ checkIn, checkOut }, vehicle, guest] = await Promise.all([
    reportsFor(booking._id),
    VehicleModel.findById(booking.vehicleId).select('fuelType').lean(),
    UserModel.findById(booking.guestId).select('emailVerifiedAt').lean(),
  ]);
  const opensAt = new Date(booking.startAt.getTime() - CHECK_IN_OPENS_HOURS * HOUR_MS);
  const windowEnds = checkOut
    ? new Date(checkOut.createdAt.getTime() + settings.trips.damageReportWindowHours * HOUR_MS)
    : undefined;
  const party = viewer === 'STAFF' ? null : viewer;
  const emailNeeded = settings.verification.emailBeforeTripStart && !guest?.emailVerifiedAt;

  return {
    ref: booking.ref,
    role: viewer,
    bookingStatus: booking.status,
    energy: vehicle?.fuelType === 'EV' ? 'BATTERY' : 'FUEL',
    fuelPolicy: booking.terms.fuelPolicy,
    requiredAngles: [...REQUIRED_INSPECTION_ANGLES],
    checkInOpensAt: opensAt.toISOString(),
    checkIn: checkIn ? toReportView(record, checkIn, viewer) : null,
    checkOut: checkOut ? toReportView(record, checkOut, viewer) : null,
    ...(windowEnds && { damageWindowEndsAt: windowEnds.toISOString() }),
    emailVerificationNeeded: emailNeeded,
    ...(checkIn && checkOut && { kilometres: kilometresFor(booking, checkIn, checkOut) }),
    fuelShortfall: fuelShort(booking, checkIn, checkOut),
    actions: {
      checkIn: Boolean(party) && booking.status === 'CONFIRMED' && !checkIn && now >= opensAt,
      checkOut: Boolean(party) && booking.status === 'ACTIVE' && Boolean(checkIn) && !checkOut,
      confirmCheckIn: Boolean(party && checkIn) && !confirmedBy(checkIn, party!),
      confirmCheckOut: Boolean(party && checkOut) && !confirmedBy(checkOut, party!),
      // Either party, for the whole damage-report window after check-out (plan §8.2): confirming the
      // check-out doesn't end it, so a Guest who did the check-out can still flag what they spot later.
      flagDamage: Boolean(party && checkOut && windowEnds) && now < windowEnds!,
    },
  };
}

async function confirmPhotos(
  booking: BookingDocument,
  input: Pick<InspectionInput, 'photos'>,
  takenBy: string,
  now: Date,
) {
  const { folder, isPrivate } = bookingUploadFolder('INSPECTION_PHOTO', booking.id);
  return Promise.all(
    input.photos.map(async (photo) => ({
      angle: photo.angle,
      url: await getStorage().confirmUpload({ folder, isPrivate, ref: photo.key }),
      takenBy: new mongoose.Types.ObjectId(takenBy),
      // A device clock in the future can't be right; the server's time stands in.
      takenAt: new Date(Math.min(new Date(photo.takenAt).getTime(), now.getTime())),
      // What the photo itself says; kept as sent, so an old gallery photo shows (plan §3).
      ...(photo.exifTakenAt && { exifTakenAt: new Date(photo.exifTakenAt) }),
      uploadedAt: now,
      ...(photo.lat !== undefined && photo.lng !== undefined && { lat: photo.lat, lng: photo.lng }),
    })),
  );
}

/** Tells the other party a report waits for their review, and notes it in the booking's chat. */
async function announce(
  booking: BookingRecord,
  stage: InspectionStage,
  by: 'GUEST' | 'HOST' | 'STAFF',
  report: Pick<ConditionReport, 'odometer' | 'fuelOrBatteryPct'>,
  session: ClientSession,
  now: Date,
) {
  const [guest, host] = await Promise.all([
    UserModel.findById(booking.guestId).select('firstName').session(session).lean(),
    UserModel.findById(booking.hostId).select('firstName').session(session).lean(),
  ]);
  const names = {
    GUEST: guest?.firstName ?? 'The guest',
    HOST: host?.firstName ?? 'The host',
    STAFF: 'Rento Vroom support',
  };
  const what = stage === 'CHECK_IN' ? 'Check-in' : 'Check-out';
  const reading = `odometer ${report.odometer.toLocaleString('en-NZ')} km, ${report.fuelOrBatteryPct}% fuel or charge`;
  await postSystemMessage(
    booking,
    `${what} done by ${names[by]} at ${formatNzDateTime(now)} (NZ time): ${reading}.${by === 'STAFF' ? '' : ` ${names[by === 'GUEST' ? 'HOST' : 'GUEST']}, please review the photos and confirm.`}`,
    { session, now },
  );

  for (const role of ['GUEST', 'HOST'] as const) {
    if (role === by) continue;
    const path = handoverPath(booking, role);
    await notify(
      {
        userId: role === 'GUEST' ? booking.guestId : booking.hostId,
        type: stage === 'CHECK_IN' ? 'CHECK_IN_DONE' : 'CHECK_OUT_DONE',
        title: `${what} done: please review`,
        body: `${names[by]} recorded the ${booking.vehicleSnapshot.title}'s condition. Check the photos and readings, then confirm.`,
        link: path,
        email: {
          template: 'tripNotice',
          props: {
            firstName: names[role],
            heading: `${what} done: please review`,
            paragraphs: [
              `${names[by]} recorded the ${booking.vehicleSnapshot.title}'s condition at ${what.toLowerCase()}: ${reading}.`,
              stage === 'CHECK_OUT' && role === 'HOST'
                ? 'Please check the photos and confirm. If you find new damage, flag it from the booking within the damage-report window.'
                : 'Please check the photos and readings, and confirm. If something isn’t right, flag it there and then.',
            ],
            rows: [
              { label: 'Booking', value: booking.ref },
              { label: 'Car', value: booking.vehicleSnapshot.title },
            ],
            buttonLabel: 'Review and confirm',
            url: `${siteUrl()}${path}`,
          },
        },
        dedupeKey: `${stage}_DONE:${booking._id.toString()}:${role}`,
      },
      { session },
    );
  }
}

/** The car's last check-out reading, before this booking; a check-in below it is flagged to support. */
async function lastCheckOutOdometer(booking: BookingDocument): Promise<number | null> {
  const others = await BookingModel.find({
    vehicleId: booking.vehicleId,
    _id: mongoose.trusted({ $ne: booking._id }),
    status: 'COMPLETED',
  })
    .select('_id')
    .lean();
  if (others.length === 0) return null;
  const last = await ConditionReportModel.findOne({
    bookingId: mongoose.trusted({ $in: others.map((other) => other._id) }),
    stage: 'CHECK_OUT',
  })
    .sort({ createdAt: -1 })
    .select('odometer')
    .lean();
  return last?.odometer ?? null;
}

const problem = (code: string, message: string) => new HttpError(409, code, message);

/**
 * POST /bookings/{id}/inspections: a check-in starts the trip (CONFIRMED → ACTIVE); a check-out ends it
 * (ACTIVE → COMPLETED). The person who records it confirms it; the other party confirms later. Support
 * staff complete a trip whose check-out is missing the same way (plan §8.2).
 */
export async function submitInspection(
  booking: BookingDocument,
  viewer: Viewer,
  actorId: string,
  input: InspectionInput,
  now = new Date(),
): Promise<void> {
  const settings = await getPlatformSettings();
  const { checkIn, checkOut } = await reportsFor(booking._id);
  const stage = input.stage;

  if (stage === 'CHECK_IN') {
    if (viewer === 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'Check-in is done by the guest or host.');
    if (booking.status !== 'CONFIRMED' || checkIn) {
      throw problem(
        'NOT_CHECK_IN',
        checkIn ? 'Check-in is already done.' : 'This booking isn’t ready for check-in.',
      );
    }
    if (now.getTime() < booking.startAt.getTime() - CHECK_IN_OPENS_HOURS * HOUR_MS) {
      throw problem('TOO_EARLY', `Check-in opens ${CHECK_IN_OPENS_HOURS} hours before the trip starts.`);
    }
    if (settings.verification.emailBeforeTripStart) {
      const guest = await UserModel.findById(booking.guestId).select('emailVerifiedAt').lean();
      if (!guest?.emailVerifiedAt) {
        throw problem(
          'EMAIL_NOT_VERIFIED',
          'The guest needs to confirm their email address before the trip starts. They can resend the link from their account.',
        );
      }
    }
  } else {
    // Staff may complete a trip that was marked started without a check-in in the app (plan §8.2); its
    // extra kilometres can't then be worked out.
    if (booking.status !== 'ACTIVE' || (!checkIn && viewer !== 'STAFF') || checkOut) {
      throw problem(
        'NOT_CHECK_OUT',
        checkOut
          ? 'Check-out is already done.'
          : 'Check-out comes after check-in, while the trip is under way.',
      );
    }
    if (checkIn && input.odometer < checkIn.odometer) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
        odometer: `The reading can’t be lower than at check-in (${checkIn.odometer.toLocaleString('en-NZ')} km)`,
      });
    }
  }

  const missing = REQUIRED_INSPECTION_ANGLES.filter(
    (angle) => !input.photos.some((photo) => photo.angle === angle),
  );
  if (missing.length > 0 && viewer !== 'STAFF') {
    throw new HttpError(400, 'PHOTOS_MISSING', 'Take a photo of every angle before you finish.', {
      photos: `Still needed: ${missing.map((angle) => angle.toLowerCase().replace('_', ' ')).join(', ')}`,
    });
  }

  const photos = await confirmPhotos(booking, input, actorId, now);
  const by = viewer === 'STAFF' ? 'STAFF' : viewer;
  const previousCheckOut = stage === 'CHECK_IN' ? await lastCheckOutOdometer(booking) : null;

  await withTransaction(async (session) => {
    const [report] = await ConditionReportModel.create(
      [
        {
          bookingId: booking._id,
          stage,
          submittedBy: actorId,
          odometer: input.odometer,
          fuelOrBatteryPct: input.fuelOrBatteryPct,
          ...(input.notes && { notes: input.notes }),
          photos,
          damagePins: input.damagePins.map((pin) => ({
            ...pin,
            newDamage: stage === 'CHECK_OUT',
            flaggedBy: actorId,
            flaggedAt: now,
          })),
          ...(by === 'GUEST' && { confirmedByGuestAt: now }),
          ...(by === 'HOST' && { confirmedByHostAt: now }),
          ...(by === 'STAFF' && { completedBy: actorId }),
        },
      ],
      { session },
    );
    const moved =
      stage === 'CHECK_IN'
        ? await startTrip(booking, session, {
            by: actorId,
            graceMinutes: settings.trips.lateReturnGraceMinutes,
            now,
          })
        : await completeTrip(booking, session, {
            by: actorId,
            now,
            ...(by === 'STAFF' && { reason: 'Completed by support: check-out was missing' }),
          });
    if (!moved) throw problem('ALREADY_CHANGED', 'This booking has just changed. Please refresh.');
    const record = moved.toObject() as BookingRecord;
    await announce(record, stage, by, report!, session, now);
    // The trip went ahead: a payout waiting for check-in can go (plan §8.1, item 9).
    if (stage === 'CHECK_IN')
      await releaseHeldPayouts({ bookingId: booking._id }, 'TRIP_NOT_STARTED', { session, now });
    if (stage === 'CHECK_OUT')
      await afterTripCompleted(
        record,
        checkIn ? { checkIn, checkOut: report!.toObject() as ReportRecord } : null,
        session,
        now,
      );
  });

  if (previousCheckOut !== null && stage === 'CHECK_IN' && input.odometer < previousCheckOut) {
    await alertStaff({
      type: 'ODOMETER_MISMATCH',
      title: `Odometer lower than last time on ${booking.ref}`,
      body: `check-in on ${booking.ref} recorded ${input.odometer.toLocaleString('en-NZ')} km, below the car's last check-out reading of ${previousCheckOut.toLocaleString('en-NZ')} km. Please check the dashboard photo.`,
      link: `/admin/bookings/${booking.ref}`,
      dedupeKey: `ODOMETER_MISMATCH:${booking.id}`,
    });
  }
  if (viewer === 'STAFF') {
    await recordAudit({
      actorId,
      action: 'booking.completed-by-support',
      entity: 'booking',
      entityId: booking.id,
      before: { status: booking.status },
      after: {
        status: 'COMPLETED',
        odometer: input.odometer,
        fuelOrBatteryPct: input.fuelOrBatteryPct,
        photos: photos.length,
        ...(input.notes && { notes: input.notes }),
      },
    });
  }
}

/** POST /bookings/{id}/inspections/{stage}/confirm: the other party agrees the report is right. */
export async function confirmInspection(
  booking: BookingDocument,
  viewer: Viewer,
  stage: InspectionStage,
  now = new Date(),
): Promise<void> {
  if (viewer === 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'The guest or host confirms the report.');
  const field = viewer === 'GUEST' ? 'confirmedByGuestAt' : 'confirmedByHostAt';
  const updated = await ConditionReportModel.updateOne(
    { bookingId: booking._id, stage, [field]: mongoose.trusted({ $exists: false }) },
    { $set: { [field]: now } },
  );
  if (updated.matchedCount === 0 && !(await ConditionReportModel.exists({ bookingId: booking._id, stage }))) {
    throw new HttpError(404, 'NOT_FOUND', 'That report hasn’t been done yet.');
  }
}

/**
 * POST /bookings/{id}/inspections/CHECK_OUT/damage: new damage found after the trip. Either party can add
 * it once the check-out is recorded, until the damage-report window in settings closes (plan §8.2).
 */
export async function flagDamage(
  booking: BookingDocument,
  viewer: Viewer,
  actorId: string,
  input: FlagDamageInput,
  now = new Date(),
): Promise<void> {
  const handover = await getHandover(booking, viewer, now);
  if (!handover.actions.flagDamage) {
    throw problem(
      'DAMAGE_WINDOW_CLOSED',
      handover.checkOut
        ? 'The window for flagging new damage has closed. Contact support if you need help.'
        : 'New damage is flagged at check-out.',
    );
  }
  const photos = await confirmPhotos(booking, input, actorId, now);
  await withTransaction(async (session) => {
    await ConditionReportModel.updateOne(
      { bookingId: booking._id, stage: 'CHECK_OUT' },
      {
        $push: {
          damagePins: {
            $each: input.damagePins.map((pin) => ({
              ...pin,
              ...(!pin.note && input.note && { note: input.note.slice(0, 500) }),
              newDamage: true,
              flaggedBy: actorId,
              flaggedAt: now,
            })),
          },
          photos: { $each: photos },
        },
      },
      { session },
    );
    const who = viewer === 'GUEST' ? 'The guest' : 'The host';
    await postSystemMessage(
      booking,
      `${who} flagged new damage after the trip${input.note ? `: ${input.note}` : '.'} Support can help through an incident report if needed.`,
      { session, now },
    );
  });
}
