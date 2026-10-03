import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  deleteNotificationsSchema,
  markReadSchema,
  markUnreadSchema,
  notificationCountsSchema,
  notificationsDeletedSchema,
  notificationsQuerySchema,
  notificationsResponseSchema,
} from './notifications.schemas.js';

/** The contract for the notification centre: the header's bell and the Notifications page. */
export function registerNotificationPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/notifications',
    tags: ['Notifications'],
    summary: 'The bell and the Notifications page',
    description:
      'The signed-in user’s in-app notifications, newest first, a page at a time, with the unread count and the total. Deleted ones are left out.',
    security: signedIn,
    request: { query: notificationsQuerySchema },
    responses: {
      200: jsonResponse('One page of notifications', notificationsResponseSchema),
      ...errorResponses(400, 401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/notifications/read',
    tags: ['Notifications'],
    summary: 'Mark notifications read',
    security: signedIn,
    request: { body: jsonBody(markReadSchema) },
    responses: {
      200: jsonResponse('The counts afterwards', notificationCountsSchema),
      ...errorResponses(400, 401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/notifications/unread',
    tags: ['Notifications'],
    summary: 'Mark notifications unread again',
    security: signedIn,
    request: { body: jsonBody(markUnreadSchema) },
    responses: {
      200: jsonResponse('The counts afterwards', notificationCountsSchema),
      ...errorResponses(400, 401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/notifications/delete',
    tags: ['Notifications'],
    summary: 'Delete some notifications, or every one already read',
    description: 'Ids that aren’t the user’s own notifications are ignored.',
    security: signedIn,
    request: { body: jsonBody(deleteNotificationsSchema) },
    responses: {
      200: jsonResponse('How many were deleted, and the counts afterwards', notificationsDeletedSchema),
      ...errorResponses(400, 401),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/notifications/{id}',
    tags: ['Notifications'],
    summary: 'Delete a notification',
    description: 'Deleting one again is fine. Someone else’s notification is a 404.',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The notification’s id' }) }) },
    responses: { 204: { description: 'Deleted' }, ...errorResponses(401, 404) },
  });
}
