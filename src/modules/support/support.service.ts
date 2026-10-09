import mongoose, { type Types } from 'mongoose';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import type { FileAttachment } from '../../lib/model-fields.js';
import { randomRef } from '../../lib/refs.js';
import { BookingModel } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { alertStaff } from '../staff/staff-alerts.js';
import { attachmentView, confirmSupportFiles } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import type {
  ContactRequest,
  SupportTicketSummary,
  SupportTicketView,
  TicketReplyInput,
} from './support.schemas.js';
import {
  SupportTicketModel,
  type SupportTicket,
  type TicketCategory,
  type TicketMessage,
} from './support-ticket.model.js';

/*
 * Support tickets (plan §3 `supportTickets`): opened from the Contact Us form, a booking's Contact
 * support link or a privacy request, and followed up from the account's Help and support page. Staff
 * answer them from the support inbox in the staff portal.
 */

interface NewTicket {
  userId?: Types.ObjectId;
  name: string;
  email: string;
  bookingId?: Types.ObjectId;
  subject: string;
  category: TicketCategory;
  body: string;
  /** Files already checked against the sender's support folder (confirmSupportFiles). */
  attachments?: FileAttachment[];
}

async function saveTicket(ticket: NewTicket): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const ref = randomRef('ST');
    try {
      await SupportTicketModel.create({
        ref,
        ...(ticket.userId && { userId: ticket.userId }),
        name: ticket.name,
        email: ticket.email,
        ...(ticket.bookingId && { bookingId: ticket.bookingId }),
        subject: ticket.subject,
        category: ticket.category,
        messages: [
          {
            ...(ticket.userId && { authorId: ticket.userId }),
            body: ticket.body,
            attachments: ticket.attachments ?? [],
            createdAt: new Date(),
          },
        ],
      });
      return ref;
    } catch (error) {
      // Two tickets drew the same reference; draw again.
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000 && attempt < 3) continue;
      throw error;
    }
  }
}

/**
 * Saves a ticket under a fresh reference, and emails the sender the reference. A new ticket has nobody
 * on it yet, so the whole support team is alerted (plan §7, admin alerts).
 */
export async function openTicket(ticket: NewTicket): Promise<{ ref: string }> {
  const ref = await saveTicket(ticket);
  await enqueue('email.send', {
    to: ticket.email,
    template: 'supportTicketReceived',
    props: { name: ticket.name.split(' ')[0] ?? ticket.name, ref, subject: ticket.subject },
  });
  await alertStaff({
    type: 'SUPPORT_TICKET',
    title: `New ${ticket.category === 'PRIVACY' ? 'privacy request' : 'support ticket'} ${ref}`,
    body: `${ticket.name} wrote about “${ticket.subject}”: ${ticket.body.slice(0, 200)}`,
    link: `/admin/support/${ref}`,
    dedupeKey: `SUPPORT_TICKET:${ref}`,
  });
  return { ref };
}

/**
 * A message from the Contact Us form becomes a support ticket (plan §9, Days 12–14), and the sender
 * gets an email with its reference. Signed-in users' tickets are linked to their account, and to one
 * of their bookings when they give its reference. Only they can attach files: uploads need an account.
 */
export async function createContactTicket(input: ContactRequest, userId?: string): Promise<{ ref: string }> {
  const user = userId ? await UserModel.findById(userId).select('email firstName').lean() : null;
  const files = input.attachments ?? [];
  if (files.length > 0 && !user) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      attachments: 'Log in to attach files',
    });
  }
  const attachments = user ? await confirmSupportFiles(user._id.toString(), files) : [];
  const booking =
    user && input.bookingRef
      ? await BookingModel.findOne({
          ref: input.bookingRef,
          $or: [{ guestId: user._id }, { hostId: user._id }],
        })
          .select('_id')
          .lean()
      : null;

  return openTicket({
    ...(user && { userId: user._id }),
    name: input.name,
    email: input.email,
    ...(booking && { bookingId: booking._id }),
    subject: input.subject,
    category: input.category,
    body:
      input.bookingRef && !booking
        ? `${input.message}\n\nBooking reference: ${input.bookingRef}`
        : input.message,
    attachments,
  });
}

const notFound = () => new HttpError(404, 'NOT_FOUND', "We couldn't find that support request.");

type TicketRecord = SupportTicket & { _id: Types.ObjectId };

async function bookingRefs(tickets: TicketRecord[]): Promise<Map<string, string>> {
  const ids = tickets.flatMap((ticket) => (ticket.bookingId ? [ticket.bookingId] : []));
  if (ids.length === 0) return new Map();
  const bookings = await BookingModel.find({ _id: mongoose.trusted({ $in: ids }) })
    .select('ref')
    .lean();
  return new Map(bookings.map((booking) => [booking._id.toString(), booking.ref]));
}

function toSummary(ticket: TicketRecord, refs: Map<string, string>): SupportTicketSummary {
  const bookingRef = ticket.bookingId ? refs.get(ticket.bookingId.toString()) : undefined;
  const visible = ticket.messages.filter((message) => !message.internal);
  return {
    ref: ticket.ref,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    ...(bookingRef && { bookingRef }),
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: (visible.at(-1)?.createdAt ?? ticket.createdAt).toISOString(),
  };
}

/** GET /support/tickets: the signed-in user's own tickets, most recently active first. */
export async function listMyTickets(userId: string): Promise<SupportTicketSummary[]> {
  const tickets = await SupportTicketModel.find({ userId }).sort({ updatedAt: -1 }).limit(100).lean();
  const refs = await bookingRefs(tickets);
  return tickets.map((ticket) => toSummary(ticket, refs));
}

async function findMyTicket(userId: string, ref: string) {
  if (!/^ST-[A-Z0-9]{6}$/i.test(ref)) throw notFound();
  const ticket = await SupportTicketModel.findOne({ ref: ref.toUpperCase(), userId });
  if (!ticket) throw notFound();
  return ticket;
}

/** A ticket as its sender sees it: every message except the staff's internal notes. */
async function toTicketView(ticket: TicketRecord): Promise<SupportTicketView> {
  const refs = await bookingRefs([ticket]);
  return {
    ...toSummary(ticket, refs),
    messages: ticket.messages
      .filter((message) => !message.internal)
      .map((message, index) => ({
        id: String(index),
        // The sender's own messages, including the first one sent from the Contact form signed out.
        from:
          !message.authorId || (ticket.userId && message.authorId.equals(ticket.userId)) ? 'YOU' : 'SUPPORT',
        body: message.body,
        // Signed links for the ticket's own user only: this view is never shown to anyone else.
        attachments: message.attachments.map(attachmentView),
        createdAt: message.createdAt.toISOString(),
      })),
  };
}

/** GET /support/tickets/{ref}: one of the user's own tickets with its replies. */
export async function getMyTicket(userId: string, ref: string): Promise<SupportTicketView> {
  const ticket = await findMyTicket(userId, ref);
  return toTicketView(ticket.toObject() as TicketRecord);
}

/**
 * Tells support about the sender's reply: whoever has the ticket, as for a party's update on an incident,
 * or else the whole team (plan §7, admin alerts), so it doesn't wait unseen in the inbox.
 */
async function tellSupport(ticket: TicketRecord, message: TicketMessage, index: number) {
  const who = ticket.name?.trim() || 'The sender';
  const link = `/admin/support/${ticket.ref}`;
  const dedupeKey = `SUPPORT_TICKET_REPLY:${ticket.ref}:${index}`;
  const title = `${who} replied on ticket ${ticket.ref}`;
  if (ticket.assignedTo) {
    // Not about their own message, e.g. a staff member following up a ticket they opened themselves.
    if (message.authorId?.equals(ticket.assignedTo)) return;
    await notify({
      userId: ticket.assignedTo,
      type: 'SUPPORT_TICKET_REPLY',
      title,
      body: message.body.slice(0, 160),
      link,
      dedupeKey,
    });
    return;
  }
  await alertStaff({
    type: 'SUPPORT_TICKET_REPLY',
    title,
    body: `${ticket.name?.trim() || 'the sender'} replied about “${ticket.subject}”: ${message.body.slice(0, 200)}`,
    link,
    dedupeKey,
  });
}

/**
 * POST /support/tickets/{ref}/messages: the user adds to their ticket, with files they uploaded for it.
 * It goes back to support, reopening it if it was resolved.
 */
export async function replyToMyTicket(
  userId: string,
  ref: string,
  input: TicketReplyInput,
): Promise<SupportTicketView> {
  const ticket = await findMyTicket(userId, ref);
  const attachments = await confirmSupportFiles(userId, input.attachments);
  const message: TicketMessage = {
    authorId: ticket.userId,
    body: input.body,
    attachments,
    internal: false,
    createdAt: new Date(),
  };
  const updated = await SupportTicketModel.findOneAndUpdate(
    { _id: ticket._id },
    { $push: { messages: message }, $set: { status: 'OPEN' } },
    { new: true },
  ).lean();
  await tellSupport(updated!, message, updated!.messages.length - 1);
  return toTicketView(updated!);
}
