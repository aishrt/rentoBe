import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { NotificationModel } from './notification.model.js';

export const notificationItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    body: z.string().optional(),
    link: z.string().optional().meta({ description: 'A website path to open' }),
    createdAt: z.iso.datetime(),
    read: z.boolean(),
  })
  .meta({ id: 'NotificationItem' });

export const notificationsResponseSchema = z
  .object({ notifications: z.array(notificationItemSchema), unreadCount: z.number().int() })
  .meta({ id: 'Notifications' });

export const markReadSchema = z
  .object({
    ids: z
      .array(z.string().regex(/^[0-9a-f]{24}$/))
      .max(100)
      .optional()
      .meta({ description: 'Left out: marks every notification read' }),
  })
  .meta({ id: 'MarkNotificationsRead' });

const LIST_SIZE = 30;

/**
 * Mounted at /api/v1/notifications: the in-app notifications behind the header's bell (plan §7,
 * build order). The bell refreshes every minute until Socket.IO messaging arrives in Phase 3.
 */
export function notificationsRouter() {
  const router = Router();
  router.use(requireAuth);

  const unreadCount = (userId: string) =>
    NotificationModel.countDocuments({
      userId,
      channel: 'IN_APP',
      readAt: mongoose.trusted({ $exists: false }),
    });

  router.get('/', async (req, res) => {
    const userId = req.auth!.userId;
    const [items, unread] = await Promise.all([
      NotificationModel.find({ userId, channel: 'IN_APP' }).sort({ createdAt: -1 }).limit(LIST_SIZE).lean(),
      unreadCount(userId),
    ]);
    res.json({
      notifications: items.map((item) => {
        const payload = item.payload as { title?: string; body?: string; link?: string };
        return {
          id: item._id.toString(),
          type: item.type,
          title: payload.title ?? item.type,
          ...(payload.body && { body: payload.body }),
          ...(payload.link && { link: payload.link }),
          createdAt: item.createdAt.toISOString(),
          read: Boolean(item.readAt),
        };
      }),
      unreadCount: unread,
    });
  });

  router.post('/read', async (req, res) => {
    const { ids } = validate(markReadSchema, req.body ?? {});
    const userId = req.auth!.userId;
    await NotificationModel.updateMany(
      {
        userId,
        channel: 'IN_APP',
        readAt: mongoose.trusted({ $exists: false }),
        ...(ids && { _id: mongoose.trusted({ $in: ids }) }),
      },
      { $set: { readAt: new Date() } },
    );
    res.json({ unreadCount: await unreadCount(userId) });
  });

  return router;
}
