import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { reviewInputSchema } from './reviews.schemas.js';
import { submitReview } from './reviews.service.js';

/** Mounted at /api/v1/reviews, next to the public featured reviews: writing a review (spec §16). */
export function reviewWritingRouter() {
  const router = Router();

  router.post('/', requireAuth, async (req, res) => {
    const input = validate(reviewInputSchema, req.body);
    res.status(201).json({ review: await submitReview(req.auth!.userId, input) });
  });

  return router;
}
