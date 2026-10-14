import type { Types } from 'mongoose';
import { withTransaction } from '../../db.js';
import { JobModel } from '../../jobs/job.model.js';
import { HttpError } from '../../lib/http-error.js';
import { formatNzdExact } from '../../lib/format.js';
import { nzTripDays } from '../../lib/nz-time.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type Booking, type BookingDocument } from '../bookings/booking.model.js';
import { extraKmJobKey } from '../bookings/trip-completion.js';
import { postSystemMessage } from '../messages/thread-core.js';
import { addExtraCharge, cancelExtraCharge } from '../payments/extra-charges.service.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { ConditionReportModel, type ConditionReport } from './condition-report.model.js';
import { kilometresFor } from './inspections.service.js';
import type { ExtraKmView, ReadingCorrectionInput } from './inspections.schemas.js';

/*
 * Extra kilometres after a trip (plan §3, §5, §8.2): worked out from the check-in and check-out odometer
 * readings and charged to the Guest's saved card at the booking's extra-km price. The charge waits for the
 * other party to confirm the check-out, or for the damage-report window to close (trip-completion.ts), so a
 * mistyped reading can be put right first. A distance above the daily review limit in settings isn't charged
 * until staff have checked it; staff can correct a reading, and the charge is then worked out again.
 */

type Id = Types.ObjectId;
type BookingRecord = Booking & { _id: Id };
type ReportRecord = ConditionReport & { _id: Id };

const nf = new Intl.NumberFormat('en-NZ');

async function readingsFor(bookingId: Id) {
  const reports = await ConditionReportModel.find({ bookingId }).lean<ReportRecord[]>();
  return {
    checkIn: reports.find((report) => report.stage === 'CHECK_IN'),
    checkOut: reports.find((report) => report.stage === 'CHECK_OUT'),
  };
}

const rateWords = (booking: BookingRecord) => `$${(booking.terms.extraKmCents / 100).toFixed(2)} a km`;

/**
 * `trip.extraCharges`: the extra kilometres charged once, when the job comes due. Kilometres above the daily
 * review limit are left for staff, who are alerted, so a reading typed with an extra digit isn't charged.
 */
export async function chargeExtraKilometres(bookingId: string): Promise<ExtraKmView['outcome']> {
  const booking = await BookingModel.findById(bookingId).lean<BookingRecord>();
  if (!booking || booking.status !== 'COMPLETED') return 'NONE';
  // Charged once; staff charge or correct it after that.
  if (booking.extraCharges.some((charge) => charge.type === 'EXTRA_KM')) return 'UNCHANGED';
  const { checkIn, checkOut } = await readingsFor(booking._id);
  if (!checkIn || !checkOut) return 'NONE';
  const km = kilometresFor(booking, checkIn, checkOut);
  if (km.extraChargeCents <= 0) return 'NONE';

  const settings = await getPlatformSettings();
  const limit = settings.trips.extraKmReviewAboveKmPerDay;
  const perDay = km.driven / nzTripDays(booking.startAt, booking.endAt);
  if (perDay > limit) {
    await alertStaff({
      type: 'EXTRA_KM_REVIEW',
      title: `Check the odometer readings on ${booking.ref}`,
      body: `the readings on booking ${booking.ref} come to ${nf.format(km.driven)} km, about ${nf.format(Math.round(perDay))} km a day (above the ${nf.format(limit)} km a day checked first), so the ${formatNzdExact(km.extraChargeCents)} extra-kilometre charge hasn't been made. Check the dashboard photos, then charge it or correct the reading on the booking's handover.`,
      link: `/admin/bookings/${booking.ref}#handover`,
      dedupeKey: `EXTRA_KM_REVIEW:${booking._id.toString()}`,
    });
    return 'HELD';
  }
  try {
    // The charge and its collection are saved together.
    await withTransaction((session) =>
      addExtraCharge(
        booking._id,
        {
          type: 'EXTRA_KM',
          description: `${km.extra} km over the ${km.allowance} km included, at ${rateWords(booking)}`,
          amountCents: km.extraChargeCents,
          idempotencyKey: `extra-km:${booking._id.toString()}`,
        },
        session,
      ),
    );
  } catch (error) {
    // The same job running twice at once: the other added it.
    if (error instanceof HttpError && error.code === 'ALREADY_CHARGED') return 'UNCHANGED';
    throw error;
  }
  return 'CHARGED';
}

/**
 * Staff charge the extra kilometres from the readings as they stand, after checking them (one held by the
 * review limit) or correcting one (plan §8.2). A charge not yet paid is cancelled and replaced; one paid
 * already stays, with any more due charged on top, or what was paid over left for staff to refund.
 */
export async function settleExtraKilometres(
  staffId: string,
  booking: Pick<BookingRecord, '_id'>,
  reason: string,
  ip?: string,
  now = new Date(),
): Promise<ExtraKmView> {
  const record = await BookingModel.findById(booking._id).lean<BookingRecord>();
  if (!record || record.status !== 'COMPLETED') {
    throw new HttpError(409, 'NOT_COMPLETED', 'Extra kilometres are charged once the trip is completed.');
  }
  const { checkIn, checkOut } = await readingsFor(record._id);
  if (!checkIn || !checkOut) {
    throw new HttpError(
      409,
      'NO_READINGS',
      'This trip has no check-in or check-out reading to work out extra kilometres from.',
    );
  }
  const km = kilometresFor(record, checkIn, checkOut);
  const charges = record.extraCharges.filter(
    (charge) => charge.type === 'EXTRA_KM' && charge.status !== 'CANCELLED',
  );
  const collectedCents = charges
    .filter((charge) => charge.status === 'SUCCEEDED')
    .reduce((sum, charge) => sum + charge.amountCents, 0);
  const open = charges.filter((charge) => charge.status === 'PENDING' || charge.status === 'FAILED');
  const openCents = open.reduce((sum, charge) => sum + charge.amountCents, 0);
  const dueCents = km.extraChargeCents - collectedCents;
  // The job can't hold or charge it again after staff have.
  await JobModel.updateOne(
    { uniqueKey: extraKmJobKey(record._id.toString()), status: 'QUEUED' },
    { $set: { status: 'CANCELLED', finishedAt: now } },
  );

  if (open.length <= 1 && openCents === Math.max(0, dueCents)) {
    if (dueCents < 0) return overcharged(collectedCents, -dueCents);
    return dueCents === 0 && collectedCents === 0
      ? { outcome: 'NONE', message: 'There are no extra kilometres to charge.' }
      : {
          outcome: 'UNCHANGED',
          amountCents: Math.max(openCents, collectedCents),
          message:
            openCents > 0
              ? `The ${formatNzdExact(openCents)} extra-kilometre charge stays as it is.`
              : `The ${formatNzdExact(collectedCents)} paid for extra kilometres is right.`,
        };
  }

  for (const charge of open) {
    try {
      await cancelExtraCharge(staffId, record._id, charge._id!.toString(), reason, ip, now, {
        corrected: true,
      });
    } catch (error) {
      if (error instanceof HttpError && ['ALREADY_PAID', 'ALREADY_CHANGED'].includes(error.code)) {
        throw new HttpError(
          409,
          'ALREADY_CHANGED',
          'The extra-kilometre charge has just changed: the Guest may have paid it. Refresh, check it and try again.',
        );
      }
      throw error;
    }
  }
  if (dueCents < 0) return overcharged(collectedCents, -dueCents);
  if (dueCents === 0) {
    return { outcome: 'NONE', message: 'There are no extra kilometres to charge, so the charge is cancelled.' };
  }
  const dueKm = Math.round(dueCents / record.terms.extraKmCents);
  const description =
    collectedCents > 0
      ? `${dueKm} more km after a corrected reading (${km.extra} km over the ${km.allowance} km included), at ${rateWords(record)}`
      : `${km.extra} km over the ${km.allowance} km included, at ${rateWords(record)}`;
  await withTransaction((session) =>
    addExtraCharge(
      record._id,
      { type: 'EXTRA_KM', description, amountCents: dueCents, addedBy: staffId },
      session,
    ),
  );
  await recordAudit({
    actorId: staffId,
    action: 'booking.extra-km-charged',
    entity: 'booking',
    entityId: record._id.toString(),
    before: { collectedCents, openCents },
    after: { amountCents: dueCents, drivenKm: km.driven, extraKm: km.extra, reason },
    ...(ip && { ip }),
  });
  return {
    outcome: 'CHARGED',
    amountCents: dueCents,
    message: `${formatNzdExact(dueCents)} for ${nf.format(dueKm)} extra km is being charged to the Guest’s saved card.`,
  };
}

function overcharged(collectedCents: number, refundCents: number): ExtraKmView {
  return {
    outcome: 'OVERCHARGED',
    amountCents: collectedCents,
    refundCents,
    message: `The Guest has paid ${formatNzdExact(collectedCents)} for extra kilometres, ${formatNzdExact(refundCents)} more than the readings now give. Refund the difference from this booking’s payments.`,
  };
}

const STAGE_WORDS = { CHECK_IN: 'check-in', CHECK_OUT: 'check-out' } as const;

/**
 * POST /admin/bookings/{id}/readings: staff correct a condition report's odometer or fuel reading (a mistyped
 * one, read again from the dashboard photo), with a note for the audit log. The check-out reading can't go
 * below the check-in one. Both parties see the correction in the booking's messages, and a completed trip's
 * extra kilometres are worked out again from it at once.
 */
export async function correctReading(
  staffId: string,
  booking: BookingDocument,
  input: ReadingCorrectionInput,
  ip?: string,
  now = new Date(),
): Promise<ExtraKmView | undefined> {
  const { checkIn, checkOut } = await readingsFor(booking._id);
  const report = input.stage === 'CHECK_IN' ? checkIn : checkOut;
  if (!report) throw new HttpError(404, 'NOT_FOUND', 'That report hasn’t been done yet.');
  const odometer = input.odometer ?? report.odometer;
  const fuelOrBatteryPct = input.fuelOrBatteryPct ?? report.fuelOrBatteryPct;
  const fieldError = (field: 'odometer' | 'fuelOrBatteryPct', message: string) =>
    new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', { [field]: message });
  if (odometer === report.odometer && fuelOrBatteryPct === report.fuelOrBatteryPct) {
    throw fieldError('odometer', 'Enter a reading different from the one recorded');
  }
  if (input.stage === 'CHECK_OUT' && checkIn && odometer < checkIn.odometer) {
    throw fieldError(
      'odometer',
      `The reading can’t be lower than at check-in (${checkIn.odometer.toLocaleString('en-NZ')} km)`,
    );
  }
  if (input.stage === 'CHECK_IN' && checkOut && odometer > checkOut.odometer) {
    throw fieldError(
      'odometer',
      `The reading can’t be higher than at check-out (${checkOut.odometer.toLocaleString('en-NZ')} km)`,
    );
  }

  const changes = [
    odometer !== report.odometer &&
      `odometer ${report.odometer.toLocaleString('en-NZ')} km → ${odometer.toLocaleString('en-NZ')} km`,
    fuelOrBatteryPct !== report.fuelOrBatteryPct &&
      `fuel or charge ${report.fuelOrBatteryPct}% → ${fuelOrBatteryPct}%`,
  ].filter(Boolean);
  await withTransaction(async (session) => {
    const updated = await ConditionReportModel.updateOne(
      { _id: report._id, odometer: report.odometer, fuelOrBatteryPct: report.fuelOrBatteryPct },
      { $set: { odometer, fuelOrBatteryPct } },
      { session },
    );
    if (updated.modifiedCount === 0) {
      throw new HttpError(409, 'ALREADY_CHANGED', 'This reading has just changed. Please refresh.');
    }
    await postSystemMessage(
      booking,
      `Rento Vroom support corrected the ${STAGE_WORDS[input.stage]} reading: ${changes.join(', ')}.`,
      { session, now },
    );
  });
  await recordAudit({
    actorId: staffId,
    action: 'booking.reading-corrected',
    entity: 'booking',
    entityId: booking.id,
    before: { stage: input.stage, odometer: report.odometer, fuelOrBatteryPct: report.fuelOrBatteryPct },
    after: { stage: input.stage, odometer, fuelOrBatteryPct, note: input.note },
    ...(ip && { ip }),
  });

  // A completed trip's kilometres change with the reading, by staff's word: worked out again now.
  const fresh = await BookingModel.findById(booking._id).select('status').lean();
  if (odometer === report.odometer || fresh?.status !== 'COMPLETED' || !checkIn || !checkOut) {
    return undefined;
  }
  return settleExtraKilometres(
    staffId,
    booking,
    `Worked out again after a corrected ${STAGE_WORDS[input.stage]} reading: ${input.note}`,
    ip,
    now,
  );
}
