import { runDataRetention } from '../../modules/admin/data-retention.service.js';
import { runHostReminders } from '../../modules/hosts/host-reminders.service.js';
import { chargeExtraKilometres } from '../../modules/inspections/extra-km.service.js';
import { collectExtraCharge } from '../../modules/payments/extra-charges.service.js';
import { runPayout } from '../../modules/payouts/payouts.service.js';
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
  { log }: JobContext,
) {
  const outcome = await collectExtraCharge(bookingId, chargeId, attempt);
  log.info({ bookingId, chargeId, attempt, outcome }, 'Extra charge collected');
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
