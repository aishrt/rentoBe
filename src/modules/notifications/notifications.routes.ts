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
 * Notifications page (plan §7). New ones arrive live over Socket.IO; the bell also polls, in case the
 * connection drops.
 */
export function notificationsRouter() {
  const router = Router();

  // An unsubscribe link works without signing in (plan §7). An email app's one-click unsubscribe (RFC 8058)
  // posts to the header's link, with the token in the address and a form body.
  router.post('/unsubscribe', async (req, res) => {
    const { token } = validate(unsubscribeSchema, {
      token: (req.body as { token?: unknown } | undefined)?.token ?? req.query.token,
    });
    res.json({ unsubscribedFrom: await unsubscribe(token) });
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
