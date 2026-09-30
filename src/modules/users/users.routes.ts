import { Router, type RequestHandler } from 'express';
import { unauthenticated } from '../../lib/http-error.js';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { accountChangeRateLimit, codeCheckRateLimit } from '../../middleware/rate-limit.js';
import { codeSchema, mfaVerifySchema } from '../auth/auth.schemas.js';
import {
  addMfaDevice,
  disableMfa,
  getMfaStatus,
  removeMfaDevice,
  startMfaSetup,
} from '../auth/mfa.service.js';
import { acceptAgreementsSchema, changeEmailSchema, changePasswordSchema } from './account.schemas.js';
import { acceptLatestAgreements, changePassword, requestEmailChange } from './account.service.js';
import { lastSearchSchema } from './saved.schemas.js';
import { listFavourites, removeFavourite, saveFavourite, saveLastSearch } from './saved.service.js';
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

  // Staff: two-factor sign-in with up to two authenticator apps, turned on and off in the staff portal.
  router.get('/mfa', async (req, res) => {
    res.json(await getMfaStatus(req.auth!.userId));
  });

  router.post('/mfa/setup', async (req, res) => {
    res.json(await startMfaSetup(req.auth!.userId));
  });

  router.post('/mfa/verify', ...limit(codeCheckRateLimit), async (req, res) => {
    const input = validate(mfaVerifySchema, req.body);
    res.json({ user: await addMfaDevice(req.auth!, input, req.ip) });
  });

  router.post('/mfa/devices/:id/remove', ...limit(codeCheckRateLimit), async (req, res) => {
    const { code } = validate(codeSchema, req.body);
    res.json(await removeMfaDevice(req.auth!.userId, String(req.params.id), code, req.ip));
  });

  router.post('/mfa/disable', ...limit(codeCheckRateLimit), async (req, res) => {
    const { code } = validate(codeSchema, req.body);
    res.json({ user: await disableMfa(req.auth!.userId, code, req.ip) });
  });

  // Saved cars: the heart on a car card (plan §12.6).
  router.get('/favourites', async (req, res) => {
    res.json({ vehicleIds: await listFavourites(req.auth!.userId) });
  });

  router.put('/favourites/:vehicleId', async (req, res) => {
    await saveFavourite(req.auth!.userId, String(req.params.vehicleId));
    res.status(204).end();
  });

  router.delete('/favourites/:vehicleId', async (req, res) => {
    await removeFavourite(req.auth!.userId, String(req.params.vehicleId));
    res.status(204).end();
  });

  router.put('/last-search', async (req, res) => {
    await saveLastSearch(req.auth!.userId, validate(lastSearchSchema, req.body));
    res.status(204).end();
  });

  return router;
}
