import { Router, type RequestHandler } from 'express';
import { unauthenticated } from '../../lib/http-error.js';
import { parseNzDateTime } from '../../lib/nz-time.js';
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
import {
  acceptAgreementsSchema,
  changeEmailSchema,
  changePasswordSchema,
  updateMeSchema,
} from './account.schemas.js';
import { acceptLatestAgreements, changePassword, requestEmailChange, updateName } from './account.service.js';
import { hostApplicationSchema, hostProfilePatchSchema } from '../hosts/hosts.schemas.js';
import { applyToHost, getHostProfile, updateHostProfile } from '../hosts/hosts.service.js';
import { driverLicenceInputSchema } from './driver-licence.schemas.js';
import { checkoutReadiness, saveDriverLicence } from './driver-licence.service.js';
import {
  listPaymentHistory,
  listSavedCards,
  removeSavedCard,
  startCardSetup,
} from '../payments/guest-payments.service.js';
import { listBlockedUsers } from '../moderation/reports.service.js';
import { myReviews } from '../reviews/reviews.service.js';
import { identityStatus, startIdentityCheck } from './identity.service.js';
import {
  getNotificationPrefs,
  notificationPrefsPatchSchema,
  updateNotificationPrefs,
} from './notification-prefs.js';
import { privacyRequestSchema } from './privacy.schemas.js';
import { accountClosure, requestPrivacy } from './privacy.service.js';
import { lastSearchSchema } from './saved.schemas.js';
import {
  listFavourites,
  listSavedCars,
  removeFavourite,
  saveFavourite,
  saveLastSearch,
} from './saved.service.js';
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

  // Personal details (plan §11): the name, until the identity check fixes it to the ID.
  router.patch('/', ...limit(accountChangeRateLimit), async (req, res) => {
    const input = validate(updateMeSchema, req.body);
    res.json({ user: await updateName(req.auth!.userId, input, req.ip) });
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

  // Becoming a Host (plan §9, Days 8–11).
  router.post('/host-application', async (req, res) => {
    const input = validate(hostApplicationSchema, req.body);
    res.json({ host: await applyToHost(req.auth!.userId, input, req.ip) });
  });

  router.get('/host-profile', async (req, res) => {
    res.json({ host: await getHostProfile(req.auth!.userId) });
  });

  router.patch('/host-profile', async (req, res) => {
    res.json({ host: await updateHostProfile(req.auth!.userId, validate(hostProfilePatchSchema, req.body)) });
  });

  // Checkout's verification step (plan §9, Days 11–13): what's still needed, and the licence details.
  router.get('/checkout', async (req, res) => {
    const end = typeof req.query.end === 'string' ? parseNzDateTime(req.query.end) : null;
    res.json(await checkoutReadiness(req.auth!.userId, end ?? undefined));
  });

  // The identity check (plan §9, Days 19–20): Stripe Identity's page, and where the check stands.
  router.post('/verification', ...limit(accountChangeRateLimit), async (req, res) => {
    const returnTo = typeof req.body?.returnTo === 'string' ? req.body.returnTo : undefined;
    res.json(await startIdentityCheck(req.auth!.userId, returnTo));
  });

  router.get('/verification', async (req, res) => {
    res.json({ identity: await identityStatus(req.auth!.userId) });
  });

  router.put('/driver-licence', async (req, res) => {
    const input = validate(driverLicenceInputSchema, req.body);
    res.json(await saveDriverLicence(req.auth!.userId, input, req.ip));
  });

  router.put('/last-search', async (req, res) => {
    await saveLastSearch(req.auth!.userId, validate(lastSearchSchema, req.body));
    res.status(204).end();
  });

  // The Guest dashboard (spec §8): Saved cars priced for the last searched dates.
  router.get('/saved-cars', async (req, res) => {
    res.json(await listSavedCars(req.auth!.userId));
  });

  // Saved cards and payment history (plan §8.1, item 7).
  router.get('/payment-methods', async (req, res) => {
    res.json({ cards: await listSavedCards(req.auth!.userId) });
  });

  router.post('/payment-methods/setup', ...limit(accountChangeRateLimit), async (req, res) => {
    res.json(await startCardSetup(req.auth!.userId));
  });

  router.delete('/payment-methods/:id', async (req, res) => {
    await removeSavedCard(req.auth!.userId, String(req.params.id));
    res.status(204).end();
  });

  router.get('/payments', async (req, res) => {
    res.json({ payments: await listPaymentHistory(req.auth!.userId) });
  });

  // Which non-essential emails and texts the user gets (plan §7).
  router.get('/notification-prefs', async (req, res) => {
    res.json({ prefs: await getNotificationPrefs(req.auth!.userId) });
  });

  router.patch('/notification-prefs', async (req, res) => {
    const patch = validate(notificationPrefsPatchSchema, req.body);
    res.json({ prefs: await updateNotificationPrefs(req.auth!.userId, patch) });
  });

  // Reviews to write, written and received (spec §8, §9, §16).
  router.get('/reviews', async (req, res) => {
    res.json(await myReviews(req.auth!.userId));
  });

  // The people the user has blocked from messaging them (spec §13).
  router.get('/blocked-users', async (req, res) => {
    res.json({ users: await listBlockedUsers(req.auth!.userId) });
  });

  // Privacy requests and closing the account (plan §8.2, §14).
  router.get('/account-closure', async (req, res) => {
    res.json(await accountClosure(req.auth!.userId));
  });

  router.post('/privacy-requests', ...limit(accountChangeRateLimit), async (req, res) => {
    const input = validate(privacyRequestSchema, req.body);
    res.status(201).json(await requestPrivacy(req.auth!.userId, input, req.ip));
  });

  return router;
}
