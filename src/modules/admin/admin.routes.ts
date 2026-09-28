import { Router } from 'express';
import { auditStaffWrites } from '../../middleware/audit-log.js';
import { requireAuth, requireRole, requireStaffMfa } from '../../middleware/auth.js';
import { resetStaffMfa } from '../auth/mfa.service.js';
import { getAdminOverview } from './admin.service.js';

/**
 * Mounted at /api/v1/admin. Every route needs a staff role and the authenticator set up, and every
 * write is recorded in the audit log (plan §6.2).
 */
export function adminRouter() {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN', 'SUPPORT'), requireStaffMfa, auditStaffWrites);

  router.get('/overview', async (_req, res) => {
    res.json(await getAdminOverview());
  });

  // A staff member lost their authenticator: they set up a new one at their next sign-in.
  router.post('/staff/:id/mfa/reset', requireRole('ADMIN'), async (req, res) => {
    await resetStaffMfa(req.auth!.userId, String(req.params.id), req.ip);
    res.status(204).end();
  });

  return router;
}
