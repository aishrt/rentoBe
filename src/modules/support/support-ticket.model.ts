import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { attachmentSchema, type FileAttachment } from '../../lib/model-fields.js';

/** PRIVACY is for requests to access or correct personal information, or to close an account (plan §14). */
export const TICKET_CATEGORIES = [
  'BOOKING',
  'PAYMENT',
  'ACCOUNT',
  'HOSTING',
  'SAFETY',
  'PRIVACY',
  'OTHER',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_STATUSES = ['OPEN', 'PENDING', 'RESOLVED'] as const;

export interface TicketMessage {
  authorId?: Types.ObjectId;
  body: string;
  attachments: FileAttachment[];
  /** A note for support staff only. */
  internal: boolean;
  createdAt: Date;
}

/**
 * The `supportTickets` collection (plan §3). A ticket from the Contact form has a name and email instead
 * of a user.
 */
export interface SupportTicket {
  ref: string;
  userId?: Types.ObjectId;
  name?: string;
  email?: string;
  bookingId?: Types.ObjectId;
  subject: string;
  category: TicketCategory;
  status: (typeof TICKET_STATUSES)[number];
  assignedTo?: Types.ObjectId;
  messages: TicketMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const ticketMessageSchema = new Schema<TicketMessage>({
  authorId: { type: Schema.Types.ObjectId, ref: 'User' },
  body: { type: String, required: true, maxlength: 5000 },
  attachments: { type: [attachmentSchema], default: [] },
  internal: { type: Boolean, default: false },
  createdAt: { type: Date, required: true, default: Date.now },
});

const supportTicketSchema = new Schema<SupportTicket>(
  {
    ref: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: TICKET_CATEGORIES, default: 'OTHER' },
    status: { type: String, enum: TICKET_STATUSES, default: 'OPEN' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    messages: { type: [ticketMessageSchema], default: [] },
  },
  { collection: 'supportTickets', timestamps: true },
);

supportTicketSchema.pre('validate', function requireContact() {
  if (!this.userId && !this.email) {
    this.invalidate('email', 'A ticket needs a user or an email address to reply to');
  }
});

supportTicketSchema.index({ ref: 1 }, { unique: true });
// The support inbox.
supportTicketSchema.index({ status: 1, updatedAt: -1 });

export const SupportTicketModel = model<SupportTicket>('SupportTicket', supportTicketSchema);
export type SupportTicketDocument = HydratedDocument<SupportTicket>;
