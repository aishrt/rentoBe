import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  blockedUsersResponseSchema,
  reportInputSchema,
  reportResponseSchema,
} from '../moderation/reports.schemas.js';
import {
  messageResponseSchema,
  messagesQuerySchema,
  messagesResponseSchema,
  sendMessageSchema,
  staffThreadQuerySchema,
  staffThreadResponseSchema,
  threadResponseSchema,
  threadsResponseSchema,
  unreadMessagesResponseSchema,
} from './messages.schemas.js';

const refParams = z.object({
  ref: z.string().meta({ description: 'The booking reference, e.g. RV-7K2Q9M' }),
});

/** The contract for messages.routes.ts (plan §2.3): booking chats, reports and blocking. */
export function registerMessagePaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/threads',
    tags: ['Messages'],
    summary: 'Your conversations, most recent first',
    description:
      'One thread per booking, as Guest and as Host. Live updates arrive over Socket.IO as `message`.',
    security: signedIn,
    responses: { 200: jsonResponse('Conversations', threadsResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/threads/unread',
    tags: ['Messages'],
    summary: 'How many messages are unread, for the Messages badge',
    security: signedIn,
    responses: { 200: jsonResponse('Unread messages', unreadMessagesResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/threads/{ref}',
    tags: ['Messages'],
    summary: "A booking's conversation",
    description:
      'For the booking’s Guest and Host, once it has reached the Host. Says whether messages can be sent: a thread is read-only 30 days after the trip (unless an incident is open), and when either side has blocked the other.',
    security: signedIn,
    request: { params: refParams },
    responses: { 200: jsonResponse('The conversation', threadResponseSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'get',
    path: '/threads/{ref}/messages',
    tags: ['Messages'],
    summary: 'A page of messages, oldest first',
    description:
      'The newest page by default; pass `before` for older ones. Contact details in messages are hidden until the booking is confirmed. Photo links work for 10 minutes.',
    security: signedIn,
    request: { params: refParams, query: messagesQuerySchema },
    responses: { 200: jsonResponse('Messages', messagesResponseSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/threads/{ref}/messages',
    tags: ['Messages'],
    summary: 'Send a message, with up to 6 photos',
    description:
      'Photos are uploaded first with POST /uploads/signature (purpose MESSAGE_PHOTO). The other side is emailed if it’s still unread after 10 minutes. 403 ACCOUNT_SUSPENDED while your account is suspended; 409 THREAD_CLOSED when the conversation can’t take messages (`readOnlyReason` says why).',
    security: signedIn,
    request: { params: refParams, body: jsonBody(sendMessageSchema) },
    responses: {
      201: jsonResponse('Sent', messageResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/threads/{ref}/read',
    tags: ['Messages'],
    summary: 'Mark the conversation read',
    description: 'The other side sees “Seen” on their messages (Socket.IO `thread:read`).',
    security: signedIn,
    request: { params: refParams },
    responses: { 204: { description: 'Marked read' }, ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/reports',
    tags: ['Messages'],
    summary: 'Report a user, message, review or listing to support',
    description:
      'Reports go to the moderation queue. Several people reporting one person raises a risk flag.',
    security: signedIn,
    request: { body: jsonBody(reportInputSchema) },
    responses: {
      201: jsonResponse('Reported', reportResponseSchema),
      ...errorResponses(400, 401, 404, 409, 429),
    },
  });

  const userParams = z.object({ id: z.string() });
  registry.registerPath({
    method: 'post',
    path: '/users/{id}/block',
    tags: ['Messages'],
    summary: 'Block someone from messaging you',
    description:
      'Booking-critical automated messages still arrive. A Host who blocks a Guest also stops their bookings.',
    security: signedIn,
    request: { params: userParams },
    responses: { 204: { description: 'Blocked' }, ...errorResponses(401, 404, 409) },
  });

  registry.registerPath({
    method: 'delete',
    path: '/users/{id}/block',
    tags: ['Messages'],
    summary: 'Unblock someone',
    security: signedIn,
    request: { params: userParams },
    responses: { 204: { description: 'Unblocked' }, ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/blocked-users',
    tags: ['Messages'],
    summary: 'The people you have blocked',
    security: signedIn,
    responses: { 200: jsonResponse('Blocked people', blockedUsersResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/bookings/{id}/thread',
    tags: ['Admin'],
    summary: "Staff: a booking's messages, from a report, incident or ticket",
    description:
      'Support staff open a thread only from a report, incident or support ticket about the booking, and each opening is written to the audit log (plan §6.2).',
    security: signedIn,
    request: { params: z.object({ id: z.string() }), query: staffThreadQuerySchema },
    responses: {
      200: jsonResponse('The conversation', staffThreadResponseSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });
}
