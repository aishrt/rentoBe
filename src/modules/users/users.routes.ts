import { Router, type RequestHandler } from 'express';
import { unauthenticated } from '../../lib/http-error.js';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { accountChangeRateLimit, codeCheckRateLimit } from '../../middleware/rate-limit.js';
import { codeSchema } from '../auth/auth.schemas.js';
import { enableMfa, startMfaSetup } from '../auth/mfa.service.js';
import { acceptAgreementsSchema, changeEmailSchema, changePasswordSchema } from './account.schemas.js';
import { acceptLatestAgreements, changePassword, requestEmailChange } from './account.service.js';
import { UserModel } from './user.model.js';
import { toPublicUser } from './user.service.js';

/** Mounted at /api/v1/me: the signed-in user's own account. */
export function meRouter(options: { rateLimit: boolean } = { rateLimit: true }) {
  const router = Router();
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const user = await UserModel.findById(req.auth!.userId);
    // A deleted or suspended account loses access straight away, even with an unexpired access token.
    if (!user || user.status !== 'ACTIVE') throw unauthenticated();
    res.json({ user: toPublicUser(user) });
  });

  // Signs out every other device; this one stays signed in.
  router.post('/password', ...limit(accountChangeRateLimit), async (req, res) => {
    const input = validate(changePasswordSchema, req.body);
    await changePassword(req.auth!, input, req.ip);
    res.status(204).end();
  });

  // Emails a link to the new address; the current one keeps working until it's opened.
  router.post('/email', ...limit(accountChangeRateLimit), async (req, res) => {
    const input = validate(changeEmailSchema, req.body);
    res.json(await requestEmailChange(req.auth!.userId, input, req.ip));
  });

  // Accepts the current version of legal documents, e.g. the ones in the user's pendingAgreements.
  router.post('/agreements', async (req, res) => {
    const { types } = validate(acceptAgreementsSchema, req.body);
    res.json({ user: await acceptLatestAgreements(req.auth!.userId, types, req.ip) });
  });

  // Staff: set up the authenticator app for two-factor sign-in.
  router.post('/mfa/setup', async (req, res) => {
    res.json(await startMfaSetup(req.auth!.userId));
  });

  router.post('/mfa/verify', ...limit(codeCheckRateLimit), async (req, res) => {
    const { code } = validate(codeSchema, req.body);
    res.json({ user: await enableMfa(req.auth!.userId, code, req.ip) });
  });

  return router;
}
