import mongoose from 'mongoose';
import { deletePrivateFile } from '../../integrations/storage/storage.js';
import { logger } from '../../integrations/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { nextNzHour, nzDate } from '../../lib/nz-time.js';
import { AuditLogModel } from '../audit/audit-log.model.js';
import { BookingModel } from '../bookings/booking.model.js';
import { IncidentModel, OPEN_INCIDENT_STATUSES } from '../incidents/incident.model.js';
import { ConditionReportModel } from '../inspections/condition-report.model.js';
import { MessageModel } from '../messages/message.model.js';
import { ThreadModel } from '../messages/thread.model.js';
import { attachmentFiles } from '../uploads/upload-folders.js';
import { redactEarlierSessions, redactIdentity } from '../users/identity.service.js';
import { UserModel } from '../users/user.model.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Data retention (plan §14; §4.3 `daily.dataRetention`). The periods are in platformSettings, proposed until
 * the client's legal adviser confirms them: ID images 90 days after a check (Stripe deletes them; we keep the
 * result), messages, inspection photos and incident evidence 2 years after the trip unless a case is still
 * open, and audit logs 7 years. Bookings and payments stay 7 years for tax and are not touched here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The job runs at 3 am NZ time, when the site is quiet. */
const RETENTION_HOUR = 3;
/** How much one run deletes at most, so a first run on an old database doesn't take too long. */
const BATCH = 200;
/** Defence in depth under the settings' 7-year floor: the job never deletes an audit log younger than this. */
const MIN_AUDIT_LOG_AGE_MS = 365 * DAY_MS;

export interface RetentionResult {
  identitiesRedacted: number;
  tripsCleared: number;
  auditLogsDeleted: number;
}

export async function scheduleDataRetention(now = new Date()) {
  const runAt = nextNzHour(now, RETENTION_HOUR);
  await enqueue('daily.dataRetention', {}, { runAt, uniqueKey: `daily.dataRetention:${nzDate(runAt)}` });
}

async function removeFiles(urls: string[]) {
  for (const url of urls) {
    try {
      await deletePrivateFile(url);
    } catch (error) {
      logger.warn({ err: error }, 'Could not delete a file past its retention period');
    }
  }
}

/** One day's clean-up. Each step is safe to run again. */
export async function runDataRetention(now = new Date()): Promise<RetentionResult> {
  await scheduleDataRetention(now);
  const settings = await getPlatformSettings();
  const result: RetentionResult = { identitiesRedacted: 0, tripsCleared: 0, auditLogsDeleted: 0 };

  // ID images: Stripe Identity redacts the session; the result stays on the account. A check that passed goes
  // 90 days after it passed; one that was turned down or never finished, 90 days after it began. One that
  // support is still reviewing (PENDING) keeps its images until they decide, unless the account is closed:
  // support's queue leaves closed accounts out, so its check goes 90 days after it began, whatever its status.
  const idCutoff = new Date(now.getTime() - settings.retention.idImagesDays * DAY_MS);
  const checked = await UserModel.find({
    'identityVerification.providerRef': mongoose.trusted({ $exists: true }),
    'identityVerification.redactedAt': mongoose.trusted({ $exists: false }),
    $or: [
      { 'identityVerification.verifiedAt': mongoose.trusted({ $lte: idCutoff }) },
      {
        'identityVerification.status': mongoose.trusted({ $in: ['NONE', 'REJECTED'] }),
        'identityVerification.startedAt': mongoose.trusted({ $lte: idCutoff }),
      },
      // Turned down before staff decisions kept the start time: 90 days after the account last changed.
      {
        'identityVerification.status': 'REJECTED',
        'identityVerification.startedAt': mongoose.trusted({ $exists: false }),
        updatedAt: mongoose.trusted({ $lte: idCutoff }),
      },
      // A closed account's check, even one still in review.
      {
        closedAt: mongoose.trusted({ $exists: true }),
        'identityVerification.startedAt': mongoose.trusted({ $lte: idCutoff }),
      },
      // One begun before checks kept their start time: 90 days after the account closed.
      {
        closedAt: mongoose.trusted({ $lte: idCutoff }),
        'identityVerification.startedAt': mongoose.trusted({ $exists: false }),
      },
    ],
  })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const user of checked) {
    try {
      if (await redactIdentity(user._id.toString(), now)) result.identitiesRedacted += 1;
    } catch (error) {
      logger.warn({ err: error, userId: user._id.toString() }, 'Could not redact an identity check');
    }
  }
  // Checks the person started again: each one 90 days after it began, whatever became of the latest.
  const restarted = await UserModel.find({
    'identityVerification.earlierSessions': mongoose.trusted({
      $elemMatch: { startedAt: { $lte: idCutoff }, redactedAt: { $exists: false } },
    }),
  })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const user of restarted) {
    result.identitiesRedacted += await redactEarlierSessions(user._id.toString(), idCutoff, now);
  }

  // Trip records: messages, their photos, inspection photos and closed cases' evidence.
  const tripCutoff = new Date(now.getTime() - settings.retention.tripRecordsYears * 365 * DAY_MS);
  // Bookings with a case still open wait for it, and are left out of the batch so they never fill it.
  const heldByCases = await IncidentModel.distinct('bookingId', {
    status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }),
  });
  const oldBookings = await BookingModel.find({
    endAt: mongoose.trusted({ $lte: tripCutoff }),
    tripRecordsClearedAt: mongoose.trusted({ $exists: false }),
    _id: mongoose.trusted({ $nin: heldByCases }),
  })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const { _id: bookingId } of oldBookings) {
    if (await IncidentModel.exists({ bookingId, status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }) }))
      continue;
    const thread = await ThreadModel.findOne({ bookingId }).select('_id').lean();
    if (thread) {
      const messages = await MessageModel.find({ threadId: thread._id }).select('attachments').lean();
      // A message photo's smaller copy goes with it.
      await removeFiles(messages.flatMap((message) => message.attachments.flatMap(attachmentFiles)));
      await MessageModel.deleteMany({ threadId: thread._id });
    }
    const reports = await ConditionReportModel.find({ bookingId }).select('photos').lean();
    await removeFiles(reports.flatMap((report) => report.photos.map((photo) => photo.url)));
    await ConditionReportModel.updateMany({ bookingId }, { $set: { photos: [] } });
    const incidents = await IncidentModel.find({ bookingId }).select('events').lean();
    await removeFiles(
      incidents.flatMap((incident) =>
        incident.events.flatMap((event) => event.attachments.map((file) => file.url)),
      ),
    );
    // The only change ever made to an incident's events: its evidence leaves with the retention period.
    await IncidentModel.updateMany({ bookingId }, { $set: { 'events.$[].attachments': [] } });
    await BookingModel.updateOne({ _id: bookingId }, { $set: { tripRecordsClearedAt: now } });
    result.tripsCleared += 1;
  }

  const auditCutoff = new Date(now.getTime() - settings.retention.auditLogYears * 365 * DAY_MS);
  // The settings keep audit logs 7 years at least; whatever is stored, a log under a year old is never deleted.
  if (now.getTime() - auditCutoff.getTime() < MIN_AUDIT_LOG_AGE_MS) {
    logger.error(
      { auditLogYears: settings.retention.auditLogYears },
      'Audit log retention under a year: no audit logs deleted',
    );
    return result;
  }
  const deleted = await AuditLogModel.deleteMany({ createdAt: mongoose.trusted({ $lte: auditCutoff }) });
  result.auditLogsDeleted = deleted.deletedCount;
  return result;
}
