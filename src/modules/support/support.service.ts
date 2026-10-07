import mongoose, { type Types } from 'mongoose';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { randomRef } from '../../lib/refs.js';
import { BookingModel } from '../bookings/booking.model.js';
import { UserModel } from '../users/user.model.js';
import type { ContactRequest, SupportTicketSummary, SupportTicketView } from './support.schemas.js';
import { SupportTicketModel, type SupportTicket, type TicketCategory } from './support-ticket.model.js';

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
}

/** Saves a ticket under a fresh reference, and emails the sender the reference. */
export async function openTicket(ticket: NewTicket): Promise<{ ref: string }> {
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
          { ...(ticket.userId && { authorId: ticket.userId }), body: ticket.body, createdAt: new Date() },
        ],
      });
      await enqueue('email.send', {
        to: ticket.email,
        template: 'supportTicketReceived',
        props: { name: ticket.name.split(' ')[0] ?? ticket.name, ref, subject: ticket.subject },
      });
      return { ref };
    } catch (error) {
      // Two tickets drew the same reference; draw again.
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000 && attempt < 3) continue;
      throw error;
    }
  }
}

/**
 * A message from the Contact Us form becomes a support ticket (plan §9, Days 12–14), and the sender
 * gets an email with its reference. Signed-in users' tickets are linked to their account, and to one
 * of their bookings when they give its reference.
 */
export async function createContactTicket(input: ContactRequest, userId?: string): Promise<{ ref: string }> {
  const user = userId ? await UserModel.findById(userId).select('email firstName').lean() : null;
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
 * POST /support/tickets/{ref}/messages: the user adds to their ticket. It goes back to support,
 * reopening it if it was resolved.
 */
export async function replyToMyTicket(userId: string, ref: string, body: string): Promise<SupportTicketView> {
  const ticket = await findMyTicket(userId, ref);
  const updated = await SupportTicketModel.findOneAndUpdate(
    { _id: ticket._id },
    {
      $push: { messages: { authorId: ticket.userId, body, internal: false, createdAt: new Date() } },
      $set: { status: 'OPEN' },
    },
    { new: true },
  ).lean();
  return toTicketView(updated!);
}
