import { z } from 'zod';
import { BOOKING_STATUSES } from '../bookings/booking.model.js';
import { attachmentInputSchema, attachmentViewSchema } from '../uploads/uploads.schemas.js';

/** Up to 6 photos in one message. */
export const MAX_MESSAGE_PHOTOS = 6;

/** What both sides of a conversation see in place of a message support removed. */
export const REMOVED_MESSAGE_NOTICE = 'This message was removed by Rento Vroom support.';

/** What removing a message answers: no words or photos, which staff see in the conversation itself. */
export const removedMessageResponseSchema = z
  .object({ id: z.string(), removed: z.literal(true) })
  .meta({ id: 'RemovedMessageResponse' });

export const messageViewSchema = z
  .object({
    id: z.string(),
    from: z.enum(['ME', 'THEM', 'SYSTEM']).meta({
      description: 'For support staff: THEM is the Guest and ME the Host, see `sender`',
    }),
    sender: z.enum(['GUEST', 'HOST', 'SYSTEM']),
    body: z.string().meta({
      description: 'Phone numbers, emails and links are hidden until the booking is confirmed',
    }),
    attachments: z.array(attachmentViewSchema),
    createdAt: z.iso.datetime(),
    readAt: z.iso
      .datetime()
      .optional()
      .meta({ description: 'Your own messages: when the other side read it' }),
    removed: z
      .object({
        at: z.iso.datetime(),
        reason: z.string().optional().meta({ description: 'Support staff only: why it was removed' }),
      })
      .optional()
      .meta({
        description:
          'Removed by support. The Guest and Host get the notice as the body and no photos; support staff still see the original.',
      }),
  })
  .meta({ id: 'Message' });
export type MessageView = z.infer<typeof messageViewSchema>;

export const threadSummarySchema = z
  .object({
    ref: z.string().meta({ description: "The booking's reference; one thread per booking" }),
    bookingStatus: z.enum(BOOKING_STATUSES),
    role: z.enum(['GUEST', 'HOST', 'STAFF']).meta({ description: 'Your side of the booking' }),
    vehicle: z.object({ title: z.string(), photoUrl: z.string().optional() }),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    otherParty: z.object({
      id: z.string(),
      firstName: z.string(),
      avatarUrl: z.string().optional(),
    }),
    lastMessage: z
      .object({
        body: z.string(),
        from: z.enum(['ME', 'THEM', 'SYSTEM']),
        hasPhotos: z.boolean(),
        createdAt: z.iso.datetime(),
      })
      .optional(),
    unreadCount: z.number().int(),
    readOnly: z.boolean(),
  })
  .meta({ id: 'ThreadSummary' });
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadsResponseSchema = z
  .object({ threads: z.array(threadSummarySchema), unreadTotal: z.number().int() })
  .meta({ id: 'Threads' });

export const unreadMessagesResponseSchema = z
  .object({ count: z.number().int() })
  .meta({ id: 'UnreadMessages' });

export const threadDetailSchema = threadSummarySchema
  .extend({
    canSend: z.boolean(),
    readOnlyReason: z.string().optional().meta({ description: 'Why messages can’t be sent, to show' }),
    blockedByMe: z.boolean().meta({ description: 'You blocked the other person; unblock to message them' }),
    contactsHidden: z
      .boolean()
      .meta({ description: 'The booking isn’t confirmed, so contact details in messages are hidden' }),
    closesAt: z.iso.datetime().meta({ description: 'When the thread becomes read-only' }),
  })
  .meta({ id: 'ThreadDetail' });
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const threadResponseSchema = z.object({ thread: threadDetailSchema }).meta({ id: 'ThreadResponse' });

export const messagesQuerySchema = z.object({
  before: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional()
    .meta({ description: 'An older page: the messages before this message id' }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const messagesResponseSchema = z
  .object({
    messages: z.array(messageViewSchema).meta({ description: 'Oldest first' }),
    hasMore: z.boolean().meta({ description: 'Older messages exist; ask with `before` = the first id' }),
  })
  .meta({ id: 'Messages' });

export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(2000, { error: 'Messages can be up to 2,000 characters' }).default(''),
    attachments: z
      .array(attachmentInputSchema)
      .max(MAX_MESSAGE_PHOTOS, { error: `Up to ${MAX_MESSAGE_PHOTOS} photos at a time` })
      .default([]),
  })
  .refine((input) => input.body.length > 0 || input.attachments.length > 0, {
    error: 'Write a message or add a photo',
    path: ['body'],
  })
  .meta({ id: 'SendMessageRequest' });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const messageResponseSchema = z.object({ message: messageViewSchema }).meta({ id: 'MessageResponse' });

/** Why support staff open a thread: only from a report, incident or support ticket (plan §6.2). */
export const staffThreadQuerySchema = z.object({
  context: z
    .string()
    .regex(/^(REPORT:[0-9a-f]{24}|INCIDENT:IN-[A-Z0-9]{6}|TICKET:ST-[A-Z0-9]{6})$/i, {
      error: 'Open a thread from a report, incident or support ticket',
    })
    .meta({ description: 'REPORT:<report id>, INCIDENT:<case number> or TICKET:<ticket reference>' }),
});

export const removeMessageSchema = z
  .object({ reason: z.string().trim().min(3, { error: 'Say why' }).max(500) })
  .meta({ id: 'RemoveMessageRequest' });

export const staffThreadResponseSchema = z
  .object({
    thread: threadDetailSchema,
    guest: z.object({ id: z.string(), firstName: z.string() }),
    host: z.object({ id: z.string(), firstName: z.string() }),
    messages: z.array(messageViewSchema),
  })
  .meta({ id: 'StaffThread' });
