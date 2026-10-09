import mongoose from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { nzDate } from '../../lib/nz-time.js';
import { JobModel } from '../../jobs/job.model.js';
import { recordAudit } from '../audit/audit.service.js';
import { AuditLogModel } from '../audit/audit-log.model.js';
import { BookingModel } from '../bookings/booking.model.js';
import { IncidentModel, OPEN_INCIDENT_STATUSES } from '../incidents/incident.model.js';
import { ReportModel } from '../moderation/report.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { PayoutModel } from '../payouts/payout.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { SupportTicketModel } from '../support/support-ticket.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel, liveVehicleFilter } from '../vehicles/vehicle.model.js';
import type { adminDashboardSchema, auditQuerySchema, jobQuerySchema } from './admin-ops.schemas.js';
import { nzDayStart } from './admin-bookings.service.js';
import { rangeMoney, reportRange } from './admin-reports.service.js';
import { identityReviewFilter, licenceReviewFilter } from './verification-queue.service.js';

/*
 * The staff portal's overview with the spec §18 figures for a date range and the queues waiting for the
 * team, the audit log (plan §14), and background jobs that failed, to look at and run again (plan §4.2).
 */

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** GET /admin/dashboard: figures for a range of NZ days (the last 30 by default), and the work waiting. */
export async function adminDashboard(
  query: { from?: string; to?: string },
  now = new Date(),
): Promise<z.infer<typeof adminDashboardSchema>> {
  const to = query.to ?? nzDate(now);
  const from = query.from ?? nzDate(new Date(nzDayStart(to).getTime() - 29 * DAY_MS));
  const range = reportRange(from, to);
  const inRange = { $gte: range.start, $lt: range.end };
  const open = mongoose.trusted({ $in: [...OPEN_INCIDENT_STATUSES] });
  const counts = await Promise.all([
    UserModel.countDocuments({
      roles: mongoose.trusted({ $in: ['GUEST', 'HOST'] }),
      closedAt: mongoose.trusted({ $exists: false }),
    }),
    UserModel.countDocuments({ roles: 'HOST', status: 'ACTIVE', 'hostProfile.status': 'APPROVED' }),
    // Cars Guests can find and book, as search counts them (plan §8.2).
    VehicleModel.countDocuments(liveVehicleFilter()),
    BookingModel.countDocuments({
      status: mongoose.trusted({ $in: ['PENDING', 'CONFIRMED'] }),
      startAt: mongoose.trusted({ $gt: now }),
    }),
    BookingModel.countDocuments({ status: 'CANCELLED', cancelledAt: mongoose.trusted(inRange) }),
    IncidentModel.countDocuments({ createdAt: mongoose.trusted(inRange) }),
    IncidentModel.countDocuments({ status: open }),
    // The same people the Verifications queue lists.
    UserModel.countDocuments(identityReviewFilter()),
    UserModel.countDocuments(await licenceReviewFilter()),
    UserModel.countDocuments({ status: 'SUSPENDED', closedAt: mongoose.trusted({ $exists: false }) }),
    VehicleModel.countDocuments({ status: 'SUSPENDED' }),
    UserModel.countDocuments({ 'hostProfile.status': 'APPLIED' }),
    VehicleModel.countDocuments({
      $or: [
        { status: 'UNDER_REVIEW' },
        {
          status: mongoose.trusted({ $in: ['ACTIVE', 'INACTIVE'] }),
          $or: [{ 'photos.status': 'PENDING' }, { 'documents.status': 'PENDING' }],
        },
      ],
    }),
    SupportTicketModel.countDocuments({ status: 'OPEN' }),
    ReportModel.countDocuments({ status: 'OPEN' }),
    ReviewModel.countDocuments({ 'moderation.state': 'HELD' }),
    UserModel.countDocuments({
      riskFlags: mongoose.trusted({ $elemMatch: { clearedAt: { $exists: false } } }),
    }),
    PaymentModel.countDocuments({
      status: 'FAILED',
      createdAt: mongoose.trusted({ $gte: new Date(now.getTime() - 30 * DAY_MS) }),
    }),
    PayoutModel.countDocuments({ status: mongoose.trusted({ $in: ['HELD', 'FAILED'] }) }),
    JobModel.countDocuments({ status: 'FAILED' }),
  ]);
  const [
    totalUsers,
    activeHosts,
    activeVehicles,
    upcomingBookings,
    cancellations,
    incidentCases,
    openIncidentCases,
    identityReviews,
    licenceReviews,
    suspendedUsers,
    suspendedVehicles,
    hostApplications,
    listingReviews,
    supportTickets,
    reports,
    heldReviews,
    riskFlags,
    failedPayments,
    heldPayouts,
    failedJobs,
  ] = counts;
  // Money is counted as the Reports page counts it, so both agree for the same dates.
  const [money, payouts] = await Promise.all([
    rangeMoney(range),
    PayoutModel.aggregate<{ total: number }>([
      { $match: { status: 'PAID', paidAt: inRange } },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ]),
  ]);
  return {
    from,
    to,
    figures: {
      totalUsers: totalUsers!,
      activeHosts: activeHosts!,
      activeVehicles: activeVehicles!,
      upcomingBookings: upcomingBookings!,
      bookingRevenueCents: money.bookingRevenueCents,
      platformFeesCents: money.platformFeesCents,
      hostPayoutsCents: payouts[0]?.total ?? 0,
      cancellations: cancellations!,
      incidentCases: incidentCases!,
      openIncidentCases: openIncidentCases!,
      pendingVerifications: identityReviews! + licenceReviews!,
      suspendedUsers: suspendedUsers!,
      suspendedVehicles: suspendedVehicles!,
    },
    queues: {
      hostApplications: hostApplications!,
      listingReviews: listingReviews!,
      verifications: identityReviews! + licenceReviews!,
      incidents: openIncidentCases!,
      supportTickets: supportTickets!,
      reports: reports!,
      heldReviews: heldReviews!,
      riskFlags: riskFlags!,
      failedPayments: failedPayments!,
      heldPayouts: heldPayouts!,
      failedJobs: failedJobs!,
    },
    generatedAt: now.toISOString(),
  };
}

/** GET /admin/audit: the audit log, newest first, by who, what record or which action. */
export async function auditLog(query: z.infer<typeof auditQuerySchema>) {
  const filter: Record<string, unknown> = {
    ...(query.actor && { actorId: new mongoose.Types.ObjectId(query.actor) }),
    ...(query.entity && { entity: query.entity }),
    ...(query.entityId && { entityId: query.entityId }),
    ...(query.action && { action: query.action }),
  };
  const [entries, total] = await Promise.all([
    AuditLogModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    AuditLogModel.countDocuments(filter),
  ]);
  const actors = await UserModel.find({
    _id: mongoose.trusted({ $in: entries.flatMap((entry) => entry.actorId ?? []) }),
  })
    .select('firstName lastName email')
    .lean();
  return {
    entries: entries.map((entry) => {
      const actor = entry.actorId && actors.find((candidate) => candidate._id.equals(entry.actorId!));
      return {
        id: entry._id.toString(),
        ...(entry.actorId && {
          actor: {
            id: entry.actorId.toString(),
            name: actor ? `${actor.firstName} ${actor.lastName}` : 'Former member',
          },
        }),
        action: entry.action,
        entity: entry.entity,
        ...(entry.entityId && { entityId: entry.entityId }),
        ...(entry.before !== undefined && { before: entry.before }),
        ...(entry.after !== undefined && { after: entry.after }),
        ...(entry.ip && { ip: entry.ip }),
        createdAt: entry.createdAt.toISOString(),
      };
    }),
    total,
    page: query.page,
  };
}

/** GET /admin/jobs: background jobs that failed (or are waiting or running), newest first. */
export async function listJobs(query: z.infer<typeof jobQuerySchema>) {
  const filter = { status: query.status };
  const [jobs, total] = await Promise.all([
    JobModel.find(filter)
      .sort({ updatedAt: -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    JobModel.countDocuments(filter),
  ]);
  return {
    jobs: jobs.map((job) => ({
      id: job._id.toString(),
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      ...(job.lastError && { lastError: job.lastError.slice(0, 2000) }),
      ...(job.refId && { refId: job.refId }),
      runAt: job.runAt.toISOString(),
      ...(job.finishedAt && { finishedAt: job.finishedAt.toISOString() }),
    })),
    total,
    page: query.page,
  };
}

/** POST /admin/jobs/{id}/retry: a failed job runs again now, with a fresh set of attempts. */
export async function retryJob(staffId: string, jobId: string, ip?: string) {
  const job = mongoose.isValidObjectId(jobId)
    ? await JobModel.findOneAndUpdate(
        { _id: jobId, status: 'FAILED' },
        {
          $set: { status: 'QUEUED', runAt: new Date(), attempts: 0 },
          $unset: { finishedAt: 1, lockedAt: 1, lockedBy: 1 },
        },
        { new: true },
      ).lean()
    : null;
  if (!job) throw new HttpError(404, 'NOT_FOUND', 'No failed job with that id.');
  await recordAudit({
    actorId: staffId,
    action: 'job.retried',
    entity: 'job',
    entityId: jobId,
    after: { type: job.type },
    ...(ip && { ip }),
  });
  return { id: job._id.toString(), status: job.status };
}
