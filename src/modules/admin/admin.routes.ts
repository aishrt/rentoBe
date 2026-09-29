import { Router } from 'express';
import { auditStaffWrites } from '../../middleware/audit-log.js';
import { requireActiveAccount, requireAuth, requireRole } from '../../middleware/auth.js';
import { resetStaffMfa } from '../auth/mfa.service.js';
import { createTestPayment, getTestPayment } from '../payments/test-payment.service.js';
import { getAdminOverview } from './admin.service.js';

/**
 * Mounted at /api/v1/admin. Every route needs an active staff account, and every write is recorded
 * in the audit log (plan §6.2).
 */
export function adminRouter() {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN', 'SUPPORT'), requireActiveAccount, auditStaffWrites);

  router.get('/overview', async (_req, res) => {
    res.json(await getAdminOverview());
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

  return router;
}
