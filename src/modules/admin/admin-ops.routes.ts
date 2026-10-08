import { Router, type Request } from 'express';
import { requirePermission, requireRole } from '../../middleware/auth.js';
import { validate } from '../../lib/validate.js';
import { REPORT_STATUSES, type ReportStatus } from '../moderation/report.model.js';
import {
  adminBookingDetail,
  adminRefund,
  editBookingStatus,
  listBookings,
  suspendVehicle,
  unsuspendVehicle,
} from './admin-bookings.service.js';
import {
  createFaq,
  createHelpArticle,
  deleteFaq,
  deleteHelpArticle,
  editDestination,
  editLegalPage,
  featuredChoice,
  legalPages,
  listDestinations,
  listFaqs,
  listHelpArticles,
  setFeatured,
  updateFaq,
  updateHelpArticle,
  vehicleChoices,
} from './admin-content.service.js';
import { holdPayout, listPayments, listPayouts, releasePayout, retryPayout } from './admin-money.service.js';
import { listReports, resolveReport } from './admin-moderation.service.js';
import {
  adminRefundSchema,
  adminStatusEditSchema,
  auditQuerySchema,
  bookingListQuerySchema,
  destinationEditSchema,
  exportQuerySchema,
  faqInputSchema,
  featuredVehiclesSchema,
  helpArticleInputSchema,
  holdPayoutSchema,
  jobQuerySchema,
  legalPageEditSchema,
  overviewQuerySchema,
  paymentListQuerySchema,
  payoutListQuerySchema,
  permissionsSchema,
  reportRangeSchema,
  resolveReportSchema,
  staffTicketReplySchema,
  suspendSchema,
  ticketListQuerySchema,
  ticketUpdateSchema,
  userListQuerySchema,
  waiveFeeSchema,
} from './admin-ops.schemas.js';
import { adminDashboard, auditLog, listJobs, retryJob } from './admin-audit.service.js';
import { exportReport, platformReport } from './admin-reports.service.js';
import { listTickets, replyToTicket, staffTicket, updateTicket } from './admin-support.service.js';
import {
  clearRiskFlag,
  closeAccount,
  listUsers,
  riskQueue,
  setStaffPermissions,
  suspendUser,
  unsuspendUser,
  userDetail,
  waiveHostFee,
} from './admin-users.service.js';

const actor = (req: Request) => ({ userId: req.auth!.userId, roles: req.auth!.roles });
const param = (req: Request, name: string) => String(req.params[name]);

/**
 * The staff portal's operations (spec §18; plan §6.2, §9 Days 19–23), used by admin.routes.ts after its
 * guards: an active staff account, and every write in the audit log. Support staff have users, bookings,
 * verifications, incidents, the support inbox and moderation; money needs the refunds permission; content,
 * reports, the audit log and jobs are the admin's.
 */
export function adminOpsRouter() {
  const router = Router();
  const adminOnly = requireRole('ADMIN');
  const money = requirePermission('REFUNDS');

  router.get('/dashboard', async (req, res) => {
    res.json(await adminDashboard(validate(overviewQuerySchema, req.query)));
  });

  // Users (plan §8.2: suspensions, account closure).
  router.get('/users', async (req, res) => {
    res.json(await listUsers(validate(userListQuerySchema, req.query)));
  });

  router.get('/users/:id', async (req, res) => {
    res.json({ user: await userDetail(param(req, 'id')) });
  });

  router.post('/users/:id/suspend', async (req, res) => {
    const { reason } = validate(suspendSchema, req.body);
    res.json({
      user: await suspendUser(req.auth!.userId, req.auth!.roles, param(req, 'id'), reason, req.ip),
    });
  });

  router.post('/users/:id/unsuspend', async (req, res) => {
    res.json({ user: await unsuspendUser(req.auth!.userId, req.auth!.roles, param(req, 'id'), req.ip) });
  });

  router.post('/users/:id/risk-flags/:flagId/clear', async (req, res) => {
    res.json({ user: await clearRiskFlag(req.auth!.userId, param(req, 'id'), param(req, 'flagId'), req.ip) });
  });

  router.post('/users/:id/close', adminOnly, async (req, res) => {
    res.json({ user: await closeAccount(req.auth!.userId, req.auth!.roles, param(req, 'id'), req.ip) });
  });

  router.post('/users/:id/waive-host-fee', money, async (req, res) => {
    const { amountCents, reason } = validate(waiveFeeSchema, req.body);
    res.json({ user: await waiveHostFee(req.auth!.userId, param(req, 'id'), amountCents, reason, req.ip) });
  });

  router.post('/staff/:id/permissions', adminOnly, async (req, res) => {
    const { refunds } = validate(permissionsSchema, req.body);
    res.json({ user: await setStaffPermissions(req.auth!.userId, param(req, 'id'), refunds, req.ip) });
  });

  router.get('/risk', async (_req, res) => {
    res.json({ users: await riskQueue() });
  });

  // Bookings: search, the whole record, status edits and refunds.
  router.get('/bookings', async (req, res) => {
    res.json(await listBookings(validate(bookingListQuerySchema, req.query)));
  });

  router.get('/bookings/:id', async (req, res) => {
    res.json(await adminBookingDetail(actor(req), param(req, 'id')));
  });

  router.post('/bookings/:id/status', async (req, res) => {
    const input = validate(adminStatusEditSchema, req.body);
    res.json(await editBookingStatus(actor(req), param(req, 'id'), input, req.ip));
  });

  router.post('/bookings/:id/refunds', money, async (req, res) => {
    const input = validate(adminRefundSchema, req.body);
    res.json(await adminRefund(actor(req), param(req, 'id'), input, req.ip));
  });

  // Suspending a car (plan §8.2): hidden at once, with its upcoming bookings to decide.
  router.post('/vehicles/:id/suspend', async (req, res) => {
    const { reason } = validate(suspendSchema, req.body);
    res.json(await suspendVehicle(req.auth!.userId, param(req, 'id'), reason, req.ip));
  });

  router.post('/vehicles/:id/unsuspend', async (req, res) => {
    res.json(await unsuspendVehicle(req.auth!.userId, param(req, 'id'), req.ip));
  });

  // Payments and payouts.
  router.get('/payments', money, async (req, res) => {
    res.json(await listPayments(validate(paymentListQuerySchema, req.query)));
  });

  router.get('/payouts', money, async (req, res) => {
    res.json(await listPayouts(validate(payoutListQuerySchema, req.query)));
  });

  router.post('/payouts/:id/hold', adminOnly, async (req, res) => {
    const { reason } = validate(holdPayoutSchema, req.body);
    res.json({ payout: await holdPayout(req.auth!.userId, param(req, 'id'), reason, req.ip) });
  });

  router.post('/payouts/:id/release', adminOnly, async (req, res) => {
    res.json({ payout: await releasePayout(req.auth!.userId, param(req, 'id'), req.ip) });
  });

  router.post('/payouts/:id/retry', adminOnly, async (req, res) => {
    res.json({ payout: await retryPayout(req.auth!.userId, param(req, 'id'), req.ip) });
  });

  // The support inbox.
  router.get('/support/tickets', async (req, res) => {
    res.json(await listTickets(req.auth!.userId, validate(ticketListQuerySchema, req.query)));
  });

  router.get('/support/tickets/:ref', async (req, res) => {
    res.json({ ticket: await staffTicket(param(req, 'ref')) });
  });

  router.post('/support/tickets/:ref/messages', async (req, res) => {
    const input = validate(staffTicketReplySchema, req.body);
    res.json({ ticket: await replyToTicket(req.auth!.userId, param(req, 'ref'), input, req.ip) });
  });

  router.patch('/support/tickets/:ref', async (req, res) => {
    const input = validate(ticketUpdateSchema, req.body);
    res.json({ ticket: await updateTicket(req.auth!.userId, param(req, 'ref'), input, req.ip) });
  });

  // Moderation: what members reported.
  router.get('/moderation/reports', async (req, res) => {
    const status = REPORT_STATUSES.find((value) => value === req.query.status) as ReportStatus | undefined;
    res.json({ reports: await listReports(status) });
  });

  router.post('/moderation/reports/:id/resolve', async (req, res) => {
    const { status, resolution } = validate(resolveReportSchema, req.body);
    res.json({ report: await resolveReport(req.auth!.userId, param(req, 'id'), status, resolution, req.ip) });
  });

  // Content (admin only).
  router.get('/content/featured-vehicles', adminOnly, async (_req, res) => {
    res.json(await featuredChoice());
  });

  router.put('/content/featured-vehicles', adminOnly, async (req, res) => {
    const { vehicleIds } = validate(featuredVehiclesSchema, req.body);
    res.json(await setFeatured(req.auth!.userId, vehicleIds, req.ip));
  });

  router.get('/content/vehicles', adminOnly, async (req, res) => {
    res.json(await vehicleChoices(typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined));
  });

  router.get('/content/legal', adminOnly, async (_req, res) => {
    res.json(await legalPages());
  });

  router.put('/content/legal/:key', adminOnly, async (req, res) => {
    const input = validate(legalPageEditSchema, req.body);
    res.json({ page: await editLegalPage(req.auth!.userId, param(req, 'key'), input, req.ip) });
  });

  router.get('/content/destinations', adminOnly, async (_req, res) => {
    res.json(await listDestinations());
  });

  router.patch('/content/destinations/:slug', adminOnly, async (req, res) => {
    const input = validate(destinationEditSchema, req.body);
    res.json({ destination: await editDestination(req.auth!.userId, param(req, 'slug'), input, req.ip) });
  });

  router.get('/content/faqs', adminOnly, async (_req, res) => {
    res.json(await listFaqs());
  });

  router.post('/content/faqs', adminOnly, async (req, res) => {
    const input = validate(faqInputSchema, req.body);
    res.status(201).json({ faq: await createFaq(req.auth!.userId, input, req.ip) });
  });

  router.put('/content/faqs/:id', adminOnly, async (req, res) => {
    const input = validate(faqInputSchema, req.body);
    res.json({ faq: await updateFaq(req.auth!.userId, param(req, 'id'), input, req.ip) });
  });

  router.delete('/content/faqs/:id', adminOnly, async (req, res) => {
    await deleteFaq(req.auth!.userId, param(req, 'id'), req.ip);
    res.status(204).end();
  });

  router.get('/content/help-articles', adminOnly, async (_req, res) => {
    res.json(await listHelpArticles());
  });

  router.post('/content/help-articles', adminOnly, async (req, res) => {
    const input = validate(helpArticleInputSchema, req.body);
    res.status(201).json({ article: await createHelpArticle(req.auth!.userId, input, req.ip) });
  });

  router.put('/content/help-articles/:id', adminOnly, async (req, res) => {
    const input = validate(helpArticleInputSchema, req.body);
    res.json({ article: await updateHelpArticle(req.auth!.userId, param(req, 'id'), input, req.ip) });
  });

  router.delete('/content/help-articles/:id', adminOnly, async (req, res) => {
    await deleteHelpArticle(req.auth!.userId, param(req, 'id'), req.ip);
    res.status(204).end();
  });

  // Platform reports with CSV export, the audit log, and failed jobs (admin only).
  router.get('/reports/summary', adminOnly, async (req, res) => {
    const { from, to } = validate(reportRangeSchema, req.query);
    res.json({ report: await platformReport(from, to) });
  });

  router.get('/reports/export', adminOnly, async (req, res) => {
    const { filename, csv } = await exportReport(validate(exportQuerySchema, req.query));
    res
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  router.get('/audit', adminOnly, async (req, res) => {
    res.json(await auditLog(validate(auditQuerySchema, req.query)));
  });

  router.get('/jobs', adminOnly, async (req, res) => {
    res.json(await listJobs(validate(jobQuerySchema, req.query)));
  });

  router.post('/jobs/:id/retry', adminOnly, async (req, res) => {
    res.json({ job: await retryJob(req.auth!.userId, param(req, 'id'), req.ip) });
  });

  return router;
}
