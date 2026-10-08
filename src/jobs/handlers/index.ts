import type { Logger } from 'pino';
import type { JobDocument } from '../job.model.js';
import {
  expirePaymentHoldJob,
  expireRequestJob,
  paymentReceiptJob,
  paymentRiskCheckJob,
  refundUnwantedJob,
} from './booking-jobs.js';
import { sendEmailJob } from './email-send.js';
import { refreshExchangeRatesJob } from './exchange-rates.js';
import { identitySyncJob, unreadMessageEmailJob } from './message-jobs.js';
import {
  collectExtraChargeJob,
  dataRetentionJob,
  hostRemindersJob,
  payoutTransferJob,
  tripExtraChargesJob,
} from './payout-jobs.js';
import { sendNotificationJob } from './notification-send.js';
import { expandRecurringJob } from './recurring-availability.js';
import {
  pickupReminderJob,
  returnCheckJob,
  returnReminderJob,
  revealReviewsJob,
  reviewRequestJob,
  startCheckJob,
} from './trip-jobs.js';

export interface JobContext {
  job: JobDocument;
  log: Logger;
}

/**
 * One handler per job type (plan §4.3). A job can run again after a retry or a crash, so every
 * handler checks the current state before acting and never does the same work twice.
 */
export const jobHandlers = {
  'email.send': sendEmailJob,
  'daily.exchangeRates': refreshExchangeRatesJob,
  'notification.send': sendNotificationJob,
  'booking.expirePaymentHold': expirePaymentHoldJob,
  'booking.expireRequest': expireRequestJob,
  'payment.receipt': paymentReceiptJob,
  'payment.refundUnwanted': refundUnwantedJob,
  'availability.expandRecurring': expandRecurringJob,
  'messages.unreadEmail': unreadMessageEmailJob,
  'reminder.pickup': pickupReminderJob,
  'reminder.return': returnReminderJob,
  'trip.startCheck': startCheckJob,
  'trip.returnCheck': returnCheckJob,
  'payout.transfer': payoutTransferJob,
  'extraCharge.collect': collectExtraChargeJob,
  'trip.extraCharges': tripExtraChargesJob,
  'daily.hostReminders': hostRemindersJob,
  'trip.reviewRequest': reviewRequestJob,
  'reviews.reveal': revealReviewsJob,
  'identity.sync': identitySyncJob,
  'daily.dataRetention': dataRetentionJob,
  'risk.paymentCheck': paymentRiskCheckJob,
} satisfies Record<string, (payload: never, context: JobContext) => Promise<void>>;

export type JobType = keyof typeof jobHandlers;
export type JobPayload<Type extends JobType> = Parameters<(typeof jobHandlers)[Type]>[0];
export type JobHandlers = {
  [Type in JobType]: (payload: JobPayload<Type>, context: JobContext) => Promise<void>;
};
