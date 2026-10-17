import { formatNzdExact } from '../../lib/format.js';
import { runDataRetention } from '../../modules/admin/data-retention.service.js';
import { BookingModel } from '../../modules/bookings/booking.model.js';
import { runHostReminders } from '../../modules/hosts/host-reminders.service.js';
import { chargeExtraKilometres } from '../../modules/inspections/extra-km.service.js';
import { collectExtraCharge } from '../../modules/payments/extra-charges.service.js';
import { runPayout } from '../../modules/payouts/payouts.service.js';
import { alertStaff } from '../../modules/staff/staff-alerts.js';
import type { JobContext } from './index.js';

/* Money after the trip (plan §4.3): Host payouts, extra charges and the extra-kilometre check. */

/** `payout.transfer`: sends a payout when it's due, or holds it with the reason (plan §8.1, item 9). */
export async function payoutTransferJob({ payoutId }: { payoutId: string }, { log }: JobContext) {
  const outcome = await runPayout(payoutId);
  log.info({ payoutId, outcome }, 'Payout checked');
}

/** `extraCharge.collect`: charges an extra charge to the Guest's saved card. */
export async function collectExtraChargeJob(
  { bookingId, chargeId, attempt }: { bookingId: string; chargeId: string; attempt: number },
  { job, log }: JobContext,
) {
  const lastTry = job.attempts >= job.maxAttempts;
  let outcome: Awaited<ReturnType<typeof collectExtraCharge>>;
  try {
    outcome = await collectExtraCharge(bookingId, chargeId, attempt, new Date(), { lastTry });
  } catch (error) {
    // Still thrown on the last try (Stripe wouldn't even make the charge's PaymentIntent, say): the Guest has
    // no pay link and no try is left, so staff are told. The job is still recorded as failed.
    if (lastTry) {
      await uncollectedCharge(bookingId, chargeId).catch((alertError: unknown) =>
        log.warn({ err: alertError, bookingId, chargeId }, 'Couldn’t alert staff to an uncollected charge'),
      );
    }
    throw error;
  }
  log.info({ bookingId, chargeId, attempt, outcome }, 'Extra charge collected');
}

/** Alerts staff to an extra charge still waiting to be collected after the job's last try. */
async function uncollectedCharge(bookingId: string, chargeId: string) {
  const booking = await BookingModel.findById(bookingId).select('ref extraCharges').lean();
  const charge = booking?.extraCharges.find((candidate) => candidate._id?.equals(chargeId));
  if (!booking || charge?.status !== 'PENDING') return;
  await alertStaff({
    type: 'EXTRA_CHARGE_FAILED',
    title: `An extra charge on ${booking.ref} couldn't be collected`,
    body: `Stripe kept giving errors when collecting the ${formatNzdExact(charge.amountCents)} charge (${charge.description}) on booking ${booking.ref}, so nothing was charged and the guest hasn't been sent a link to pay it. Check Stripe's status and the job log.`,
    link: `/admin/bookings/${booking.ref}`,
    dedupeKey: `EXTRA_CHARGE_FAILED:${chargeId}:uncollected`,
  });
}

/**
 * `trip.extraCharges`: once the check-out is confirmed or the damage-report window closes, kilometres over the
 * booking's allowance are charged at its extra-km price (plan §5). Worked out from the condition reports,
 * never typed in; a distance above the daily review limit waits for staff.
 */
export async function tripExtraChargesJob({ bookingId }: { bookingId: string }, { log }: JobContext) {
  const outcome = await chargeExtraKilometres(bookingId);
  log.info({ bookingId, outcome }, 'Extra kilometres checked');
}

/** `daily.hostReminders` (plan §4.3): documents, RUC, maintenance and cars expiring before a booked trip. */
export async function hostRemindersJob(_payload: Record<string, never>, { log }: JobContext) {
  const sent = await runHostReminders();
  log.info({ sent }, 'Host reminders sent');
}

/** `daily.dataRetention` (plan §4.3, §14): ID images, trip records and audit logs past their periods. */
export async function dataRetentionJob(_payload: Record<string, never>, { log }: JobContext) {
  const result = await runDataRetention();
  log.info(result, 'Data retention applied');
}
