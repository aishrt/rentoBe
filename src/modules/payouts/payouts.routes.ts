import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { earningsStatement, hostEarnings } from '../hosts/earnings.service.js';
import { payLinkView, startPayLink, syncPayLink } from '../payments/extra-charges.service.js';
import { UserModel } from '../users/user.model.js';
import { dashboardLink, onboardingLink, payoutAccountView, syncPayoutAccount } from './connect.service.js';
import { statementQuerySchema } from './payouts.schemas.js';
import { listHostPayouts } from './payouts.service.js';

/** Mounted at /api/v1/host, next to the vehicle routes: the Host's payouts and payout setup. */
export function hostPayoutsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/payouts', async (req, res) => {
    const host = await UserModel.findById(req.auth!.userId).select('hostProfile').lean();
    res.json({
      account: payoutAccountView(host?.hostProfile),
      payouts: await listHostPayouts(req.auth!.userId),
    });
  });

  // The earnings dashboard and the GST-ready statement (spec §9, §23).
  router.get('/earnings', async (req, res) => {
    res.json(await hostEarnings(req.auth!.userId));
  });

  router.get('/earnings/statement', async (req, res) => {
    const { period } = validate(statementQuerySchema, req.query);
    const { filename, csv } = await earningsStatement(req.auth!.userId, period);
    res
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  });

  // Stripe Connect Express (plan §8.1, item 8): the Host sets up payouts on Stripe's pages.
  router.post('/connect/onboarding-link', async (req, res) => {
    res.json(await onboardingLink(req.auth!.userId));
  });

  router.post('/connect/sync', async (req, res) => {
    res.json({ account: await syncPayoutAccount(req.auth!.userId) });
  });

  router.post('/connect/dashboard-link', async (req, res) => {
    res.json(await dashboardLink(req.auth!.userId));
  });

  return router;
}

/** Mounted at /api/v1/payments: the Guest's link to pay an extra charge (plan §11: POST /payments/{id}/pay). */
export function payLinkRouter() {
  const router = Router();
  router.use(requireAuth);

  router.get('/:id', async (req, res) => {
    res.json({ payment: await payLinkView(req.auth!.userId, String(req.params.id)) });
  });

  router.post('/:id/pay', async (req, res) => {
    res.json(await startPayLink(req.auth!.userId, String(req.params.id)));
  });

  router.post('/:id/sync', async (req, res) => {
    res.json({ payment: await syncPayLink(req.auth!.userId, String(req.params.id)) });
  });

  return router;
}
