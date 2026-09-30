import { z } from 'zod';
import { TICKET_CATEGORIES } from './support-ticket.model.js';

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
  })
  .meta({ id: 'ContactRequest' });
export type ContactRequest = z.infer<typeof contactRequestSchema>;

export const contactResponseSchema = z
  .object({ ref: z.string().meta({ description: 'The support ticket reference, e.g. ST-4HX8PA' }) })
  .meta({ id: 'ContactResponse' });
