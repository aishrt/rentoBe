import { z } from 'zod';

/** At most this many ids in one request, and in one page of the list. */
export const MAX_IDS = 100;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 50;

const notificationId = z.string().regex(/^[0-9a-f]{24}$/, { error: 'Unknown notification' });
const someIds = z.array(notificationId).min(1).max(MAX_IDS);

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

/** GET /notifications. */
export const notificationsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .meta({ description: `How many to return, newest first: 1 to ${MAX_PAGE_SIZE}` }),
  cursor: z
    .string()
    .max(100)
    .optional()
    .meta({ description: 'The `nextCursor` of the page before, for the next page' }),
  unread: z.enum(['true', 'false']).optional().meta({ description: '`true`: unread ones only' }),
});

const counts = {
  unreadCount: z.number().int().meta({ description: 'Unread notifications in all, not just on this page' }),
  total: z.number().int().meta({ description: 'Every notification the user has, whatever the filter' }),
};

export const notificationCountsSchema = z.object(counts).meta({ id: 'NotificationCounts' });

export const notificationsResponseSchema = z
  .object({
    notifications: z.array(notificationItemSchema),
    ...counts,
    nextCursor: z
      .string()
      .optional()
      .meta({ description: 'Pass as `cursor` for the next page. Left out on the last page' }),
  })
  .meta({ id: 'Notifications' });

export const markReadSchema = z
  .object({
    ids: z
      .array(notificationId)
      .max(MAX_IDS)
      .optional()
      .meta({ description: 'Left out: marks every notification read' }),
  })
  .meta({ id: 'MarkNotificationsRead' });

export const markUnreadSchema = z.object({ ids: someIds }).meta({ id: 'MarkNotificationsUnread' });

export const deleteNotificationsSchema = z
  .union([
    z.object({ ids: someIds }),
    z.object({ read: z.literal(true).meta({ description: 'Deletes every notification already read' }) }),
  ])
  .meta({ id: 'DeleteNotifications' });

export const notificationsDeletedSchema = z
  .object({ deleted: z.number().int().meta({ description: 'How many were deleted' }), ...counts })
  .meta({ id: 'NotificationsDeleted' });
