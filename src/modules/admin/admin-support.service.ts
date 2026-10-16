import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { notify } from '../notifications/notify.js';
import { enqueue } from '../../jobs/queue.js';
import { SupportTicketModel, type SupportTicket } from '../support/support-ticket.model.js';
import { findActiveStaff } from '../staff/staff.service.js';
import { attachmentView, confirmSupportFiles } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import type {
  staffTicketReplySchema,
  staffTicketRowSchema,
  staffTicketSchema,
  ticketListQuerySchema,
  ticketUpdateSchema,
} from './admin-ops.schemas.js';
import { assertNotOwnRecord, isOwnRecord } from './own-record.js';

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
      ...(ticket.assignedTo && { assignedToId: ticket.assignedTo.toString() }),
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
    ...(query.user && { userId: new mongoose.Types.ObjectId(query.user) }),
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

/** Who a ticket is about: its sender, and the Guest and Host of its booking. */
async function ticketSubjects(ticket: TicketRecord) {
  const booking = ticket.bookingId
    ? await BookingModel.findById(ticket.bookingId).select('guestId hostId').lean()
    : null;
  return [ticket.userId, booking?.guestId, booking?.hostId];
}

/**
 * A support member's own request, or one about a booking they are the Guest or Host on, is someone else's to
 * answer (plan §6.2).
 */
async function assertNotOwnTicket(staffId: string, ticket: TicketRecord) {
  await assertNotOwnRecord(staffId, await ticketSubjects(ticket));
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
        attachments: message.attachments.map(attachmentView),
        internal: message.internal,
        createdAt: message.createdAt.toISOString(),
      };
    }),
  };
}

/**
 * POST /admin/support/tickets/{ref}/messages: a reply to the sender, emailed to them (and in their account's
 * notifications when they have one), or an internal note for the team. Either can carry files the staff
 * member uploaded; a reply's are seen in the sender's account, so one without an account can't have them.
 */
export async function replyToTicket(
  staffId: string,
  ref: string,
  input: z.infer<typeof staffTicketReplySchema>,
  ip?: string,
) {
  const ticket = await findTicket(ref);
  await assertNotOwnTicket(staffId, ticket);
  // A closed account can't sign in, and notify() sends it nothing: its sender is answered at the
  // address on the ticket, like a visitor from the Contact form.
  const account = ticket.userId ? await UserModel.findById(ticket.userId).select('closedAt').lean() : null;
  const accountId = account && !account.closedAt ? account._id : undefined;
  if (!input.internal && input.attachments.length > 0 && !accountId) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      attachments: 'They have no account to see files in. Describe them in the reply, or add them to a note.',
    });
  }
  const attachments = await confirmSupportFiles(staffId, input.attachments);
  const status = input.status ?? (input.internal ? ticket.status : 'PENDING');
  await SupportTicketModel.updateOne(
    { _id: ticket._id },
    {
      $push: {
        messages: {
          authorId: staffId,
          body: input.body,
          attachments,
          internal: input.internal,
          createdAt: new Date(),
        },
      },
      $set: { status, ...(!ticket.assignedTo && { assignedTo: staffId }) },
    },
  );
  if (!input.internal) {
    const staff = await UserModel.findById(staffId).select('firstName').lean();
    const firstName = ticket.name?.split(' ')[0] ?? 'there';
    const filesLine =
      attachments.length === 1
        ? 'They added a file: open your request to see it.'
        : `They added ${attachments.length} files: open your request to see them.`;
    const props = {
      firstName,
      heading: `A reply to your support request ${ticket.ref}`,
      paragraphs: [
        `${staff?.firstName ?? 'Our support team'} replied about “${ticket.subject}”:`,
        ...input.body.split(/\n{2,}/),
        ...(attachments.length > 0 ? [filesLine] : []),
      ],
      rows: [{ label: 'Reference', value: ticket.ref }],
      buttonLabel: accountId ? 'View and reply' : 'Contact us',
      url: accountId ? `${siteUrl()}/account/support/${ticket.ref}` : `${siteUrl()}/contact`,
      ...(!accountId && { note: `To reply, use the contact form and mention ${ticket.ref}.` }),
    };
    if (accountId) {
      await notify({
        userId: accountId,
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

/**
 * PATCH /admin/support/tickets/{ref}: its status, taking it, or handing it to another staff member (the admin
 * or an active support member) or to nobody, as for an incident case. Whoever is handed it is told.
 */
export async function updateTicket(
  staffId: string,
  ref: string,
  input: z.infer<typeof ticketUpdateSchema>,
  ip?: string,
) {
  const ticket = await findTicket(ref);
  const subjects = await ticketSubjects(ticket);
  await assertNotOwnRecord(staffId, subjects);
  const assignee = input.assignTo ? await findActiveStaff(input.assignTo) : null;
  if (input.assignTo && !assignee) {
    throw new HttpError(409, 'NOT_STAFF', 'Choose someone on the support team.', {
      assignTo: 'Choose someone on the support team',
    });
  }
  // Nor to a support member it's about: they couldn't answer it.
  if (assignee && (await isOwnRecord(assignee._id.toString(), subjects))) {
    throw new HttpError(409, 'OWN_RECORD', 'Choose someone else: this request is about their own account.', {
      assignTo: 'This request is about their own account',
    });
  }
  const assignedTo =
    input.assignTo === null ? null : assignee ? assignee._id : input.assignToMe ? staffId : undefined;
  await SupportTicketModel.updateOne(
    { _id: ticket._id },
    {
      $set: {
        ...(input.status && { status: input.status }),
        ...(assignedTo && { assignedTo }),
      },
      ...(assignedTo === null && { $unset: { assignedTo: 1 } }),
    },
  );
  await recordAudit({
    actorId: staffId,
    action: 'ticket.updated',
    entity: 'supportTicket',
    entityId: ticket.ref,
    before: {
      status: ticket.status,
      ...(assignedTo !== undefined && { assignedTo: ticket.assignedTo?.toString() ?? null }),
    },
    after: input,
    ...(ip && { ip }),
  });
  if (assignee && !assignee._id.equals(staffId) && !ticket.assignedTo?.equals(assignee._id)) {
    const by = await UserModel.findById(staffId).select('firstName').lean();
    await notify({
      userId: assignee._id,
      type: 'SUPPORT_TICKET_ASSIGNED',
      title: `Support request ${ticket.ref} is assigned to you`,
      body: `${by?.firstName ?? 'Support'} handed you “${ticket.subject}”.`,
      link: `/admin/support/${ticket.ref}`,
      dedupeKey: `SUPPORT_TICKET_ASSIGNED:${ticket.ref}:${assignee._id.toString()}:${Date.now()}`,
    });
  }
  return staffTicket(ticket.ref);
}
