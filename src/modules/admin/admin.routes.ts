import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { getAdminOverview } from './admin.service.js';

/** Mounted at /api/v1/admin. Every route needs a staff role (plan §6.2). */
export function adminRouter() {
  const router = Router();
  router.use(requireAuth, requireRole('ADMIN', 'SUPPORT'));

  router.get('/overview', async (_req, res) => {
    res.json(await getAdminOverview());
  });

  return router;
}
