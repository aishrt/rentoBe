import { ensureExchangeRateRefresh } from '../modules/currency/exchange-rates.service.js';
import { scheduleDataRetention } from '../modules/admin/data-retention.service.js';
import { scheduleHostReminders } from '../modules/hosts/host-reminders.service.js';
import { scheduleReviewRevealSweep } from '../modules/reviews/reviews.service.js';
import { scheduleRecurringAvailability } from './handlers/recurring-availability.js';

/**
 * Queues the next run of each daily and monthly job (plan §4.2). Runs on every start of an instance that runs
 * jobs; the dated unique keys mean several instances queue each run only once.
 */
export async function scheduleRecurringJobs(now = new Date()) {
  await ensureExchangeRateRefresh(now);
  await scheduleRecurringAvailability(now);
  await scheduleHostReminders(now);
  await scheduleDataRetention(now);
  await scheduleReviewRevealSweep(now);
}
