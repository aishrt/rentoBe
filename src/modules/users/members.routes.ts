import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { blockUser, unblockUser } from '../moderation/reports.service.js';
import { memberReviews } from '../reviews/reviews.service.js';

/** Mounted at /api/v1/users: other members, as far as each party may see them (plan §6.2). */
export function membersRouter() {
  const router = Router();

  // A member's public profile and the published reviews about them (spec §16; plan §11, a public profile):
  // only what a listing already shows of its Host, so it's open to visitors, like the listing that links to it.
  router.get('/:id/reviews', async (req, res) => {
    res.json(await memberReviews(String(req.params.id)));
  });

  router.use(requireAuth);

  router.post('/:id/block', async (req, res) => {
    await blockUser(req.auth!.userId, String(req.params.id));
    res.status(204).end();
  });

  router.delete('/:id/block', async (req, res) => {
    await unblockUser(req.auth!.userId, String(req.params.id));
    res.status(204).end();
  });

  return router;
}
