import { z } from 'zod';
import { attachmentInputSchema, attachmentViewSchema } from '../uploads/uploads.schemas.js';
import { TICKET_CATEGORIES, TICKET_STATUSES } from './support-ticket.model.js';

/**
 * Photos and PDFs with a ticket message, uploaded first with purpose SUPPORT_FILE (plan §3, public and
 * private files). Uploading needs an account, so files come from signed-in members and staff.
 */
export const ticketFilesSchema = z.array(attachmentInputSchema).max(10, { error: 'Up to 10 files' });

/** The Contact Us form (plan §9, Days 12–14). Signed-out visitors give a name and email to reply to. */
export const contactRequestSchema = z
  .object({
    name: z.string().trim().min(2, { error: 'Enter your name' }).max(100),
    email: z.email({ error: 'Enter a valid email address' }).max(254),
    category: z.enum(TICKET_CATEGORIES).default('OTHER'),
    subject: z.string().trim().min(3, { error: 'Add a short subject' }).max(200),
    message: z
      .string()
      .trim()
      .min(10, { error: 'Tell us a little more (at least 10 characters)' })
      .max(5000, { error: 'Keep it under 5,000 characters' }),
    bookingRef: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^RV-[A-Z0-9]{6}$/, { error: 'Booking references look like RV-7K2Q9M' })
      .optional()
      .or(z.literal('').transform(() => undefined)),
    attachments: ticketFilesSchema.optional().meta({
      description: 'Signed in only: photos and PDFs uploaded first with purpose SUPPORT_FILE',
    }),
  })
  .meta({ id: 'ContactRequest' });
export type ContactRequest = z.infer<typeof contactRequestSchema>;

export const contactResponseSchema = z
  .object({ ref: z.string().meta({ description: 'The support ticket reference, e.g. ST-4HX8PA' }) })
  .meta({ id: 'ContactResponse' });

export const supportTicketSummarySchema = z
  .object({
    ref: z.string(),
    subject: z.string(),
    category: z.enum(TICKET_CATEGORIES),
    status: z.enum(TICKET_STATUSES).meta({
      description: 'OPEN: with the support team. PENDING: waiting for the user’s reply. RESOLVED: done',
    }),
    bookingRef: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime().meta({ description: 'When the last message was added' }),
  })
  .meta({ id: 'SupportTicketSummary' });
export type SupportTicketSummary = z.infer<typeof supportTicketSummarySchema>;

export const supportTicketsResponseSchema = z
  .object({ tickets: z.array(supportTicketSummarySchema) })
  .meta({ id: 'SupportTickets' });

export const supportTicketSchema = supportTicketSummarySchema
  .extend({
    messages: z.array(
      z.object({
        id: z.string(),
        from: z.enum(['YOU', 'SUPPORT']),
        body: z.string(),
        attachments: z.array(attachmentViewSchema),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'SupportTicket', description: 'A user’s own ticket, without the staff’s internal notes' });
export type SupportTicketView = z.infer<typeof supportTicketSchema>;

export const supportTicketResponseSchema = z
  .object({ ticket: supportTicketSchema })
  .meta({ id: 'SupportTicketResponse' });

export const ticketReplySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(2, { error: 'Write a message' })
      .max(5000, { error: 'Keep it under 5,000 characters' }),
    attachments: ticketFilesSchema
      .default([])
      .meta({ description: 'Photos and PDFs uploaded first with purpose SUPPORT_FILE' }),
  })
  .meta({ id: 'TicketReply' });
export type TicketReplyInput = z.infer<typeof ticketReplySchema>;
