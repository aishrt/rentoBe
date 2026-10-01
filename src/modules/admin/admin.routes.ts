import { Router } from 'express';
import mongoose from 'mongoose';
import { auditStaffWrites } from '../../middleware/audit-log.js';
import { requireActiveAccount, requireAuth, requirePermission, requireRole } from '../../middleware/auth.js';
import { adminCancelBooking, bookingView, findBookingFor } from '../bookings/booking.service.js';
import { adminCancelSchema, identityReviewSchema } from '../bookings/bookings.schemas.js';
import { resetStaffMfa } from '../auth/mfa.service.js';
import { createTestPayment, getTestPayment } from '../payments/test-payment.service.js';
import { staffInviteInputSchema } from '../staff/staff.schemas.js';
import { inviteSupport, listStaff, removeSupport, revokeInvite } from '../staff/staff.service.js';
import { HttpError } from '../../lib/http-error.js';
import { addNzDays } from '../../lib/nz-time.js';
import { validate } from '../../lib/validate.js';
import { blockInputSchema } from '../vehicles/host-vehicles.schemas.js';
import {
  blockDates,
  hostCalendar,
  parseCalendarTime,
  unblockDates,
} from '../vehicles/host-vehicles.service.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import {
  documentDecisionSchema,
  photoDecisionSchema,
  requiredNotesSchema,
  reviewNotesSchema,
} from './admin-listings.schemas.js';
import {
  decideDocument,
  decideHostApplication,
  decideListing,
  decidePhoto,
  getVehicleForReview,
  isHostStatus,
  listHostApplications,
  listReviewQueue,
} from './admin-listings.service.js';
import { getAdminOverview } from './admin.service.js';
import { platformSettingsUpdateSchema } from './platform-settings.schemas.js';
import { getPlatformSettingsForAdmin, updatePlatformSettings } from './platform-settings.service.js';
import { reviewIdentity } from './admin-verification.service.js';

async function findVehicleForCalendar(id: string) {
  const vehicle = mongoose.isValidObjectId(id)
    ? await VehicleModel.findById(id).select('_id rules').lean()
    : null;
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'No such car.');
  return vehicle;
}

/**
 * Mounted at /api/v1/admin. Every route needs an active staff account, and every write is recorded
 * in the audit log (plan §6.2). requireActiveAccount runs first because it reads the account's current
 * roles, so a support member removed from the team, or an ADMIN role on an account that isn't
 * ADMIN_EMAIL, is refused at once.
 */
export function adminRouter() {
  const router = Router();
  router.use(requireAuth, requireActiveAccount, requireRole('ADMIN', 'SUPPORT'), auditStaffWrites);

  router.get('/overview', async (_req, res) => {
    res.json(await getAdminOverview());
  });

  // The staff (plan §6.2): the one admin, set by ADMIN_EMAIL, and the support team, who join only by
  // accepting the admin's invitation.
  router.get('/staff', requireRole('ADMIN'), async (_req, res) => {
    res.json(await listStaff());
  });

  router.post('/staff/invites', requireRole('ADMIN'), async (req, res) => {
    const input = validate(staffInviteInputSchema, req.body);
    res.status(201).json({ invite: await inviteSupport(req.auth!.userId, input, req.ip) });
  });

  router.delete('/staff/invites/:id', requireRole('ADMIN'), async (req, res) => {
    await revokeInvite(req.auth!.userId, String(req.params.id), req.ip);
    res.status(204).end();
  });

  router.delete('/staff/:id', requireRole('ADMIN'), async (req, res) => {
    await removeSupport(req.auth!.userId, String(req.params.id), req.ip);
    res.status(204).end();
  });

  // Platform settings (plan §3 `platformSettings`, §16): fees, cancellation tiers, protection plans and the
  // other values that wait for the client's decisions. Admin only; everything that uses them reads them
  // from the database, so a change applies at once.
  router.get('/settings', requireRole('ADMIN'), async (_req, res) => {
    res.json(await getPlatformSettingsForAdmin());
  });

  router.patch('/settings', requireRole('ADMIN'), async (req, res) => {
    const update = validate(platformSettingsUpdateSchema, req.body);
    res.json(await updatePlatformSettings(req.auth!.userId, update, req.ip));
  });

  // A staff member lost their authenticator apps: they sign in with their password and can set up a new one.
  router.post('/staff/:id/mfa/reset', requireRole('ADMIN'), async (req, res) => {
    await resetStaffMfa(req.auth!.userId, String(req.params.id), req.ip);
    res.status(204).end();
  });

  // A NZ$1 sandbox payment that checks the Stripe keys, Apple Pay, Google Pay and the webhook (plan §8.1).
  router.post('/payments/test', requireRole('ADMIN'), async (req, res) => {
    res.status(201).json(await createTestPayment(req.auth!.userId));
  });

  router.get('/payments/test/:id', requireRole('ADMIN'), async (req, res) => {
    res.json(await getTestPayment(String(req.params.id)));
  });

  // Host applications (plan §9, Days 8–11).
  router.get('/host-applications', async (req, res) => {
    const status = isHostStatus(req.query.status) ? req.query.status : 'APPLIED';
    res.json({ applications: await listHostApplications(status) });
  });

  router.post('/host-applications/:userId/approve', async (req, res) => {
    const { notes } = validate(reviewNotesSchema, req.body ?? {});
    res.json(await decideHostApplication(req.auth!.userId, String(req.params.userId), true, notes, req.ip));
  });

  router.post('/host-applications/:userId/reject', async (req, res) => {
    const { notes } = validate(requiredNotesSchema, req.body ?? {});
    res.json(await decideHostApplication(req.auth!.userId, String(req.params.userId), false, notes, req.ip));
  });

  // Listing reviews, including new photos and documents on live listings.
  router.get('/vehicles', async (_req, res) => {
    res.json({ vehicles: await listReviewQueue() });
  });

  router.get('/vehicles/:id', async (req, res) => {
    res.json(await getVehicleForReview(String(req.params.id)));
  });

  router.post('/vehicles/:id/approve', async (req, res) => {
    const { notes } = validate(reviewNotesSchema, req.body ?? {});
    res.json({
      vehicle: await decideListing(req.auth!.userId, String(req.params.id), 'APPROVED', notes, req.ip),
    });
  });

  router.post('/vehicles/:id/request-changes', async (req, res) => {
    const { notes } = validate(requiredNotesSchema, req.body ?? {});
    res.json({
      vehicle: await decideListing(
        req.auth!.userId,
        String(req.params.id),
        'CHANGES_REQUESTED',
        notes,
        req.ip,
      ),
    });
  });

  router.post('/vehicles/:id/reject', async (req, res) => {
    const { notes } = validate(requiredNotesSchema, req.body ?? {});
    res.json({
      vehicle: await decideListing(req.auth!.userId, String(req.params.id), 'REJECTED', notes, req.ip),
    });
  });

  router.post('/vehicles/:id/photos/:photoId', async (req, res) => {
    const { decision } = validate(photoDecisionSchema, req.body);
    res.json({
      vehicle: await decidePhoto(
        req.auth!.userId,
        String(req.params.id),
        String(req.params.photoId),
        decision === 'APPROVE',
        req.ip,
      ),
    });
  });

  router.post('/vehicles/:id/documents/:documentId', async (req, res) => {
    const { decision } = validate(documentDecisionSchema, req.body);
    res.json({
      vehicle: await decideDocument(
        req.auth!.userId,
        String(req.params.id),
        String(req.params.documentId),
        decision === 'VERIFY',
        req.ip,
      ),
    });
  });

  // Staff cancel a booking: a no-show or a platform cancellation, with its refund (plan §8.2).
  router.post('/bookings/:id/cancel', requirePermission('REFUNDS'), async (req, res) => {
    const { reason, note } = validate(adminCancelSchema, req.body);
    const { booking } = await findBookingFor(
      { userId: req.auth!.userId, roles: req.auth!.roles },
      String(req.params.id),
    );
    const cancelled = await adminCancelBooking(booking, req.auth!.userId, reason, note);
    res.json({ booking: await bookingView(cancelled, 'STAFF') });
  });

  // An identity check that needed a manual review: approving confirms the Guest's waiting bookings,
  // rejecting releases them (plan §8.2).
  router.post('/users/:id/identity-review', async (req, res) => {
    const { decision, note } = validate(identityReviewSchema, req.body);
    res.json(await reviewIdentity(String(req.params.id), decision, req.auth!.userId, note, req.ip));
  });

  // The calendar override (plan §9, Days 10–11): staff block or unblock dates, never over a booking.
  router.get('/vehicles/:id/calendar', async (req, res) => {
    const vehicle = await findVehicleForCalendar(String(req.params.id));
    const from = (typeof req.query.from === 'string' && parseCalendarTime(req.query.from)) || new Date();
    const requestedTo = typeof req.query.to === 'string' ? parseCalendarTime(req.query.to) : null;
    const to = requestedTo && requestedTo > from ? requestedTo : addNzDays(from, 62);
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      blocks: await hostCalendar(vehicle._id, from, to),
      rules: { minNoticeHours: vehicle.rules.minNoticeHours, bufferHours: vehicle.rules.bufferHours },
    });
  });

  router.post('/vehicles/:id/blocks', async (req, res) => {
    const vehicle = await findVehicleForCalendar(String(req.params.id));
    const input = validate(blockInputSchema, req.body);
    res.status(201).json({ block: await blockDates(vehicle._id, input, req.auth!.userId, 'ADMIN') });
  });

  router.delete('/vehicles/:id/blocks/:blockId', async (req, res) => {
    const vehicle = await findVehicleForCalendar(String(req.params.id));
    await unblockDates(vehicle._id, String(req.params.blockId), ['ADMIN', 'HOST_BLOCK', 'RECURRING']);
    res.status(204).end();
  });

  return router;
}
