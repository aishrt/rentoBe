import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { unsubscribe, unsubscribeSchema } from '../users/notification-prefs.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  deleteNotificationsSchema,
  markReadSchema,
  markUnreadSchema,
  notificationsQuerySchema,
} from './notifications.schemas.js';
import {
  deleteNotification,
  deleteNotifications,
  listNotifications,
  markRead,
  markUnread,
} from './notifications.service.js';

/**
 * Mounted at /api/v1/notifications: the in-app notifications behind the header's bell and the
 * Notifications page (plan §7). The bell refreshes every minute until Socket.IO messaging arrives in
 * Phase 3.
 */
export function notificationsRouter() {
  const router = Router();

  // The link in a marketing email works without signing in (plan §7).
  router.post('/unsubscribe', async (req, res) => {
    const { token } = validate(unsubscribeSchema, req.body);
    await unsubscribe(token);
    res.status(204).end();
  });

  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const { limit, cursor, unread } = validate(notificationsQuerySchema, req.query);
    res.json(await listNotifications(req.auth!.userId, { limit, cursor, unreadOnly: unread === 'true' }));
  });

  router.post('/read', async (req, res) => {
    const { ids } = validate(markReadSchema, req.body ?? {});
    res.json(await markRead(req.auth!.userId, ids));
  });

  router.post('/unread', async (req, res) => {
    const { ids } = validate(markUnreadSchema, req.body ?? {});
    res.json(await markUnread(req.auth!.userId, ids));
  });

  router.post('/delete', async (req, res) => {
    const target = validate(deleteNotificationsSchema, req.body ?? {});
    res.json(await deleteNotifications(req.auth!.userId, target));
  });

  router.delete('/:id', async (req, res) => {
    await deleteNotification(req.auth!.userId, String(req.params.id));
    res.status(204).end();
  });

  return router;
}
