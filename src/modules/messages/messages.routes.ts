import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { messageRateLimit, reportRateLimit } from '../../middleware/rate-limit.js';
import { reportInputSchema } from '../moderation/reports.schemas.js';
import { createReport } from '../moderation/reports.service.js';
import { messagesQuerySchema, sendMessageSchema } from './messages.schemas.js';
import {
  getThread,
  listMessages,
  listThreads,
  readThread,
  sendMessage,
  unreadTotal,
} from './messages.service.js';

const actor = (req: Request) => ({ userId: req.auth!.userId, roles: req.auth!.roles });

/** Mounted at /api/v1/threads: a chat thread for each booking (spec §13), by the booking's reference. */
export function threadsRouter(options: { rateLimit: boolean } = { rateLimit: true }) {
  const router = Router();
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    res.json(await listThreads(req.auth!.userId));
  });

  router.get('/unread', async (req, res) => {
    res.json({ count: await unreadTotal(req.auth!.userId) });
  });

  router.get('/:ref', async (req, res) => {
    res.json({ thread: await getThread(actor(req), String(req.params.ref)) });
  });

  router.get('/:ref/messages', async (req, res) => {
    const query = validate(messagesQuerySchema, req.query);
    res.json(await listMessages(actor(req), String(req.params.ref), query));
  });

  router.post('/:ref/messages', ...limit(messageRateLimit), async (req, res) => {
    const input = validate(sendMessageSchema, req.body);
    res.status(201).json({ message: await sendMessage(actor(req), String(req.params.ref), input) });
  });

  router.post('/:ref/read', async (req, res) => {
    await readThread(actor(req), String(req.params.ref));
    res.status(204).end();
  });

  return router;
}

/** Mounted at /api/v1/reports: report a user, message, review or listing to support. */
export function reportsRouter(options: { rateLimit: boolean } = { rateLimit: true }) {
  const router = Router();
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);
  router.use(requireAuth);

  router.post('/', ...limit(reportRateLimit), async (req, res) => {
    const input = validate(reportInputSchema, req.body);
    res.status(201).json(await createReport(req.auth!.userId, input));
  });

  return router;
}
