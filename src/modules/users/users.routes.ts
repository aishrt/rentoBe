import { Router } from 'express';
import { unauthenticated } from '../../lib/http-error.js';
import { requireAuth } from '../../middleware/auth.js';
import { UserModel } from './user.model.js';
import { toPublicUser } from './user.service.js';

/** Mounted at /api/v1/me: the signed-in user's own account. */
export function meRouter() {
  const router = Router();

  router.get('/', requireAuth, async (req, res) => {
    const user = await UserModel.findById(req.auth!.userId);
    // A deleted or suspended account loses access straight away, even with an unexpired access token.
    if (!user || user.status !== 'ACTIVE') throw unauthenticated();
    res.json({ user: toPublicUser(user) });
  });

  return router;
}
