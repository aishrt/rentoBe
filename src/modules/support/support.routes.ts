import { Router, type RequestHandler } from 'express';
import { validate } from '../../lib/validate.js';
import { optionalAuth } from '../../middleware/auth.js';
import { contactRateLimit } from '../../middleware/rate-limit.js';
import { contactRequestSchema } from './support.schemas.js';
import { createContactTicket } from './support.service.js';

/** Mounted at /api/v1/support. The contact form works signed out (plan §11). */
export function supportRouter(options: { rateLimit: boolean } = { rateLimit: true }) {
  const router = Router();
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);

  router.post('/tickets', ...limit(contactRateLimit), optionalAuth, async (req, res) => {
    const input = validate(contactRequestSchema, req.body);
    res.status(201).json(await createContactTicket(input, req.auth?.userId));
  });

  return router;
}
