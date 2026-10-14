import { Router, type RequestHandler } from 'express';
import { validate } from '../../lib/validate.js';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { contactRateLimit, ticketReplyRateLimit } from '../../middleware/rate-limit.js';
import { contactRequestSchema, ticketReplySchema } from './support.schemas.js';
import { createContactTicket, getMyTicket, listMyTickets, replyToMyTicket } from './support.service.js';

/**
 * Mounted at /api/v1/support. The contact form works signed out (plan §11); a signed-in user follows
 * up their own tickets (spec §8, help and support).
 */
export function supportRouter(options: { rateLimit: boolean } = { rateLimit: true }) {
  const router = Router();
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);

  router.post('/tickets', ...limit(contactRateLimit), optionalAuth, async (req, res) => {
    const input = validate(contactRequestSchema, req.body);
    res.status(201).json(await createContactTicket(input, req.auth?.userId));
  });

  router.get('/tickets', requireAuth, async (req, res) => {
    res.json({ tickets: await listMyTickets(req.auth!.userId) });
  });

  router.get('/tickets/:ref', requireAuth, async (req, res) => {
    res.json({ ticket: await getMyTicket(req.auth!.userId, String(req.params.ref)) });
  });

  router.post('/tickets/:ref/messages', requireAuth, ...limit(ticketReplyRateLimit), async (req, res) => {
    const input = validate(ticketReplySchema, req.body);
    res.json({ ticket: await replyToMyTicket(req.auth!.userId, String(req.params.ref), input) });
  });

  return router;
}
