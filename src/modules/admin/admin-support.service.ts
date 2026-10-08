import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { enqueue } from '../../jobs/queue.js';
import { SupportTicketModel, type SupportTicket } from '../support/support-ticket.model.js';
import { UserModel } from '../users/user.model.js';
import type {
  staffTicketReplySchema,
  staffTicketRowSchema,
  staffTicketSchema,
  ticketListQuerySchema,
  ticketUpdateSchema,
} from './admin-ops.schemas.js';

/*
 * The support inbox (spec §18; plan §9 Days 20–22): tickets from the Contact form, a booking's Contact
 * support link and privacy requests. Staff reply (the sender is emailed), add internal notes, take a
 * ticket, and mark it pending or resolved.
 */

type Id = Types.ObjectId;
type TicketRecord = SupportTicket & { _id: Id };

const PAGE_SIZE = 25;
const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const notFound = () => new HttpError(404, 'NOT_FOUND', 'No such support ticket.');

async function names(ids: Id[]) {
  const people = await UserModel.find({ _id: mongoose.trusted({ $in: ids }) })
    .select('firstName lastName')
    .lean();
  return (id: Id | undefined) => {
    const person = id && people.find((candidate) => candidate._id.equals(id));
    return person ? `${person.firstName} ${person.lastName}` : undefined;
  };
}

async function rows(tickets: TicketRecord[]): Promise<z.infer<typeof staffTicketRowSchema>[]> {
  const [bookings, nameOf] = await Promise.all([
    BookingModel.find({ _id: mongoose.trusted({ $in: tickets.flatMap((ticket) => ticket.bookingId ?? []) }) })
      .select('ref')
      .lean(),
    names(
      tickets.flatMap((ticket) => [ticket.userId, ticket.assignedTo].filter((id): id is Id => Boolean(id))),
    ),
  ]);
  return tickets.map((ticket) => {
    const bookingRef = ticket.bookingId
      ? bookings.find((booking) => booking._id.equals(ticket.bookingId!))?.ref
      : undefined;
    const assignedTo = nameOf(ticket.assignedTo);
    return {
      ref: ticket.ref,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      from: {
        name: nameOf(ticket.userId) ?? ticket.name ?? 'Visitor',
        email: ticket.email ?? '',
        ...(ticket.userId && { userId: ticket.userId.toString() }),
      },
      ...(bookingRef && { bookingRef }),
      ...(assignedTo && { assignedTo }),
      messages: ticket.messages.filter((message) => !message.internal).length,
      updatedAt: ticket.updatedAt.toISOString(),
      createdAt: ticket.createdAt.toISOString(),
    };
  });
}

/** GET /admin/support/tickets: the inbox, open tickets oldest-waiting first. */
export async function listTickets(staffId: string, query: z.infer<typeof ticketListQuerySchema>) {
  const filter: Record<string, unknown> = {
    status: query.status ?? mongoose.trusted({ $in: ['OPEN', 'PENDING'] }),
    ...(query.category && { category: query.category }),
    ...(query.mine && { assignedTo: new mongoose.Types.ObjectId(staffId) }),
  };
  if (query.q) {
    if (/^ST-[A-Z0-9]{6}$/i.test(query.q)) filter.ref = query.q.toUpperCase();
    else {
      const pattern = new RegExp(escape(query.q), 'i');
      filter.$or = [{ subject: pattern }, { email: pattern }, { name: pattern }];
    }
  }
  const open = !query.status || query.status !== 'RESOLVED';
  const [tickets, total] = await Promise.all([
    SupportTicketModel.find(filter)
      .sort({ updatedAt: open ? 1 : -1 })
      .skip((query.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean<TicketRecord[]>(),
    SupportTicketModel.countDocuments(filter),
  ]);
  return { tickets: await rows(tickets), total, page: query.page };
}

async function findTicket(ref: string) {
  if (!/^ST-[A-Z0-9]{6}$/i.test(ref)) throw notFound();
  const ticket = await SupportTicketModel.findOne({ ref: ref.toUpperCase() }).lean<TicketRecord>();
  if (!ticket) throw notFound();
  return ticket;
}

/** GET /admin/support/tickets/{ref}: the whole conversation, internal notes included. */
export async function staffTicket(ref: string): Promise<z.infer<typeof staffTicketSchema>> {
  const ticket = await findTicket(ref);
  const [row] = await rows([ticket]);
  const nameOf = await names(ticket.messages.flatMap((message) => message.authorId ?? []));
  return {
    ...row!,
    thread: ticket.messages.map((message, index) => {
      const fromUser = !message.authorId || (ticket.userId && message.authorId.equals(ticket.userId));
      return {
        id: String(index),
        from: fromUser ? ('USER' as const) : ('STAFF' as const),
        authorName: fromUser
          ? (row!.from.name ?? 'Visitor')
          : (nameOf(message.authorId)?.split(' ')[0] ?? 'Support'),
        body: message.body,
        internal: message.internal,
        createdAt: message.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * POST /admin/support/tickets/{ref}/messages: a reply to the sender, emailed to them (and in their account's
 * notifications when they have one), or an internal note for the team.
 */
export async function replyToTicket(
  staffId: string,
  ref: string,
  input: z.infer<typeof staffTicketReplySchema>,
  ip?: string,
) {
  const ticket = await findTicket(ref);
  const status = input.status ?? (input.internal ? ticket.status : 'PENDING');
  await SupportTicketModel.updateOne(
    { _id: ticket._id },
    {
      $push: {
        messages: { authorId: staffId, body: input.body, internal: input.internal, createdAt: new Date() },
      },
      $set: { status, ...(!ticket.assignedTo && { assignedTo: staffId }) },
    },
  );
  if (!input.internal) {
    const staff = await UserModel.findById(staffId).select('firstName').lean();
    const firstName = ticket.name?.split(' ')[0] ?? 'there';
    const props = {
      firstName,
      heading: `A reply to your support request ${ticket.ref}`,
      paragraphs: [
        `${staff?.firstName ?? 'Our support team'} replied about “${ticket.subject}”:`,
        ...input.body.split(/\n{2,}/),
      ],
      rows: [{ label: 'Reference', value: ticket.ref }],
      buttonLabel: ticket.userId ? 'View and reply' : 'Contact us',
      url: ticket.userId ? `${siteUrl()}/account/support/${ticket.ref}` : `${siteUrl()}/contact`,
      ...(!ticket.userId && { note: `To reply, use the contact form and mention ${ticket.ref}.` }),
    };
    if (ticket.userId) {
      await notify({
        userId: ticket.userId,
        type: 'SUPPORT_REPLY',
        title: `Support replied: ${ticket.subject}`,
        body: input.body.slice(0, 140),
        link: `/account/support/${ticket.ref}`,
        email: { template: 'tripNotice', props },
        dedupeKey: `SUPPORT_REPLY:${ticket.ref}:${ticket.messages.length}`,
      });
    } else if (ticket.email) {
      await enqueue('email.send', { to: ticket.email, template: 'tripNotice', props });
    }
  }
  await recordAudit({
    actorId: staffId,
    action: input.internal ? 'ticket.note' : 'ticket.replied',
    entity: 'supportTicket',
    entityId: ticket.ref,
    after: { status },
    ...(ip && { ip }),
  });
  return staffTicket(ticket.ref);
}

/** PATCH /admin/support/tickets/{ref}: its status, or taking it. */
export async function updateTicket(
  staffId: string,
  ref: string,
  input: z.infer<typeof ticketUpdateSchema>,
  ip?: string,
) {
  const ticket = await findTicket(ref);
  await SupportTicketModel.updateOne(
    { _id: ticket._id },
    {
      $set: {
        ...(input.status && { status: input.status }),
        ...(input.assignToMe && { assignedTo: staffId }),
      },
    },
  );
  await recordAudit({
    actorId: staffId,
    action: 'ticket.updated',
    entity: 'supportTicket',
    entityId: ticket.ref,
    before: { status: ticket.status },
    after: input,
    ...(ip && { ip }),
  });
  return staffTicket(ticket.ref);
}
