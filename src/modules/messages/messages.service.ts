import mongoose, { type ClientSession, type Types } from 'mongoose';
import { afterCommit, withTransaction } from '../../db.js';
import { enqueue } from '../../jobs/queue.js';
import { HttpError } from '../../lib/http-error.js';
import { emitToUser } from '../../realtime/realtime.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { BookingModel, type BookingDocument } from '../bookings/booking.model.js';
import { findBookingFor, type Actor } from '../bookings/booking.service.js';
import { isConfirmed, type Viewer } from '../bookings/booking-view.js';
import { IncidentModel, OPEN_INCIDENT_STATUSES } from '../incidents/incident.model.js';
import { ReportModel } from '../moderation/report.model.js';
import { NotificationModel } from '../notifications/notification.model.js';
import { SupportTicketModel } from '../support/support-ticket.model.js';
import { confirmBookingFiles } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import { MessageModel } from './message.model.js';
import {
  REMOVED_MESSAGE_NOTICE,
  type MessageView,
  type SendMessageInput,
  type ThreadDetail,
  type ThreadSummary,
} from './messages.schemas.js';
import {
  bookingHasThread,
  emitMessage,
  ensureThread,
  readAtFor,
  toMessageView,
  type BookingRecord,
  type MessageRecord,
  type ThreadRecord,
} from './thread-core.js';
import { ThreadModel, type ThreadDocument } from './thread.model.js';

/*
 * Messaging (spec §13, plan §9 Days 17–19): one thread per booking between its Guest and Host, live
 * over Socket.IO. Contact details are hidden until the booking is confirmed, a thread becomes read-only
 * 30 days after the trip (a setting) unless an incident is open, blocking stops messages from that
 * person, a suspended account's messages stop (plan §8.2), and support staff open a thread only from a
 * report, incident or ticket (plan §6.2) and can remove a reported message.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A message unread this long is emailed to its recipient (plan §4.3, `messages.unreadEmail`). */
export const UNREAD_EMAIL_DELAY_MS = 10 * 60 * 1000;

type Id = Types.ObjectId;

const ENDED = ['CANCELLED', 'DECLINED', 'EXPIRED'];

const noThread = () =>
  new HttpError(404, 'NO_THREAD', 'Messages open once the booking has been sent to the host.');

/** Why a suspended member can't send messages (plan §8.2: messages from them stop). */
const SUSPENDED_SENDER =
  'Your account is suspended, so you can’t send messages. Contact support if you think this is a mistake.';

/** When a thread becomes read-only: a number of days after the trip ends, or after the booking ended early. */
function closesAt(booking: BookingRecord, days: number): Date {
  const ended = ENDED.includes(booking.status)
    ? (booking.cancelledAt ?? booking.statusHistory.at(-1)?.at ?? booking.updatedAt)
    : booking.endAt;
  return new Date(ended.getTime() + days * DAY_MS);
}

async function hasOpenIncident(bookingId: Id): Promise<boolean> {
  return Boolean(
    await IncidentModel.exists({ bookingId, status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }) }),
  );
}

async function unreadCounts(threads: ThreadRecord[], userId: Id | string): Promise<Map<string, number>> {
  if (threads.length === 0) return new Map();
  const rows = await MessageModel.aggregate<{ _id: Id; count: number }>([
    {
      $match: {
        $or: threads.map((thread) => ({
          threadId: thread._id,
          createdAt: { $gt: readAtFor(thread, userId) ?? new Date(0) },
        })),
        senderId: { $ne: new mongoose.Types.ObjectId(String(userId)) },
      },
    },
    { $group: { _id: '$threadId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

async function toSummaries(threads: ThreadRecord[], userId: string, now: Date): Promise<ThreadSummary[]> {
  const settings = await getPlatformSettings();
  const bookingIds = threads.map((thread) => thread.bookingId);
  const [bookings, counts, lastMessages, openIncidents] = await Promise.all([
    BookingModel.find({ _id: mongoose.trusted({ $in: bookingIds }) }).lean<BookingRecord[]>(),
    unreadCounts(threads, userId),
    MessageModel.aggregate<MessageRecord & { _id: Id }>([
      { $match: { threadId: { $in: threads.map((thread) => thread._id) } } },
      { $sort: { threadId: 1, createdAt: -1 } },
      { $group: { _id: '$threadId', message: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$message' } },
    ]),
    IncidentModel.find({
      bookingId: mongoose.trusted({ $in: bookingIds }),
      status: mongoose.trusted({ $in: OPEN_INCIDENT_STATUSES }),
    })
      .select('bookingId')
      .lean(),
  ]);
  const others = await UserModel.find({
    _id: mongoose.trusted({
      $in: bookings.map((booking) => (booking.guestId.equals(userId) ? booking.hostId : booking.guestId)),
    }),
  })
    .select('firstName avatarUrl')
    .lean();

  const summaries: ThreadSummary[] = [];
  for (const thread of threads) {
    const booking = bookings.find((candidate) => candidate._id.equals(thread.bookingId));
    if (!booking) continue;
    const role = booking.guestId.equals(userId) ? 'GUEST' : 'HOST';
    const otherId = role === 'GUEST' ? booking.hostId : booking.guestId;
    const other = others.find((candidate) => candidate._id.equals(otherId));
    const last = lastMessages.find((message) => message.threadId.equals(thread._id));
    const incidentOpen = openIncidents.some((incident) => incident.bookingId.equals(booking._id));
    const lastView = last ? toMessageView(last, booking, role, userId) : undefined;
    summaries.push({
      ref: booking.ref,
      bookingStatus: booking.status,
      role,
      vehicle: {
        title: booking.vehicleSnapshot.title,
        ...(booking.vehicleSnapshot.photoUrl && { photoUrl: booking.vehicleSnapshot.photoUrl }),
      },
      start: booking.startAt.toISOString(),
      end: booking.endAt.toISOString(),
      otherParty: {
        id: otherId.toString(),
        firstName: other?.firstName ?? 'Former member',
        ...(other?.avatarUrl && { avatarUrl: other.avatarUrl }),
      },
      ...(lastView && {
        lastMessage: {
          body: lastView.body,
          from: lastView.from,
          hasPhotos: lastView.attachments.length > 0,
          createdAt: lastView.createdAt,
        },
      }),
      unreadCount: counts.get(thread._id.toString()) ?? 0,
      readOnly: !incidentOpen && closesAt(booking, settings.trips.threadReadOnlyDays) <= now,
    });
  }
  return summaries;
}

/** GET /threads: the user's conversations, most recent first, as Guest and as Host. */
export async function listThreads(userId: string, now = new Date()) {
  const threads = await ThreadModel.find({
    participantIds: userId,
    lastMessageAt: mongoose.trusted({ $exists: true }),
  })
    .sort({ lastMessageAt: -1 })
    .limit(100)
    .lean<ThreadRecord[]>();
  const summaries = await toSummaries(threads, userId, now);
  return { threads: summaries, unreadTotal: summaries.reduce((sum, thread) => sum + thread.unreadCount, 0) };
}

/** GET /threads/unread: how many messages wait, for the Messages tab's badge. */
export async function unreadTotal(userId: string): Promise<number> {
  const threads = await ThreadModel.find({ participantIds: userId }).select('reads').lean<ThreadRecord[]>();
  const counts = await unreadCounts(threads, userId);
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

interface ThreadAccess {
  booking: BookingDocument;
  viewer: Viewer;
  thread: ThreadDocument;
}

/** The booking's thread for its Guest or Host. Staff open threads through the staff portal instead. */
async function openThreadFor(actor: Actor, ref: string): Promise<ThreadAccess> {
  const { booking, viewer } = await findBookingFor(actor, ref);
  if (viewer === 'STAFF' || !bookingHasThread(booking)) throw noThread();
  return { booking, viewer, thread: await ensureThread(booking) };
}

async function detail(access: ThreadAccess, userId: string, now: Date): Promise<ThreadDetail> {
  const { booking, viewer, thread } = access;
  const [summary] = await toSummaries([thread.toObject() as ThreadRecord], userId, now);
  const settings = await getPlatformSettings();
  const otherId = viewer === 'GUEST' ? booking.hostId : booking.guestId;
  const [me, other, incidentOpen] = await Promise.all([
    UserModel.findById(userId).select('blockedUserIds status').lean(),
    UserModel.findById(otherId).select('blockedUserIds closedAt status').lean(),
    hasOpenIncident(booking._id),
  ]);
  // Accounts made before blocking existed have no list, and lean reads don't fill in the schema's default.
  const blockedByMe = me?.blockedUserIds?.some((id) => id.equals(otherId)) ?? false;
  const blockedMe = other?.blockedUserIds?.some((id) => id.equals(userId)) ?? false;
  const closes = closesAt(booking.toObject() as BookingRecord, settings.trips.threadReadOnlyDays);
  const readOnly = !incidentOpen && closes <= now;

  let readOnlyReason: string | undefined;
  if (readOnly) readOnlyReason = 'This conversation closed after the trip. Contact support if you need help.';
  else if (me?.status !== 'ACTIVE') readOnlyReason = SUSPENDED_SENDER;
  else if (!other || other.closedAt) readOnlyReason = 'This member has closed their account.';
  // Their messages stop while they're suspended (plan §8.2), so the conversation waits too. Rento Vroom's
  // booking messages still arrive.
  else if (other.status !== 'ACTIVE')
    readOnlyReason = `${summary!.otherParty.firstName}’s account is on hold, so you can’t message them for now. Contact support if you need help with this booking.`;
  else if (blockedByMe)
    readOnlyReason = `You blocked ${summary!.otherParty.firstName}. Unblock them to send messages.`;
  else if (blockedMe) readOnlyReason = `${summary!.otherParty.firstName} isn’t taking messages.`;

  return {
    ...summary!,
    readOnly,
    canSend: !readOnlyReason,
    ...(readOnlyReason && { readOnlyReason }),
    blockedByMe,
    contactsHidden: !isConfirmed(booking.status),
    closesAt: closes.toISOString(),
  };
}

/** GET /threads/{ref}: one conversation, made the first time it's opened. */
export async function getThread(actor: Actor, ref: string, now = new Date()): Promise<ThreadDetail> {
  return detail(await openThreadFor(actor, ref), actor.userId, now);
}

/** GET /threads/{ref}/messages: a page of messages, oldest first, newest page by default. */
export async function listMessages(
  actor: Actor,
  ref: string,
  { before, limit }: { before?: string; limit: number },
): Promise<{ messages: MessageView[]; hasMore: boolean }> {
  const { booking, viewer, thread } = await openThreadFor(actor, ref);
  const page = await MessageModel.find({
    threadId: thread._id,
    ...(before && { _id: mongoose.trusted({ $lt: new mongoose.Types.ObjectId(before) }) }),
  })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean<MessageRecord[]>();
  const hasMore = page.length > limit;
  return {
    messages: page
      .slice(0, limit)
      .reverse()
      .map((message) => toMessageView(message, booking, viewer, actor.userId)),
    hasMore,
  };
}

/** Marks everything up to `at` as read by one participant. */
async function markRead(thread: ThreadDocument, userId: Id | string, at: Date, session?: ClientSession) {
  const updated = await ThreadModel.updateOne(
    { _id: thread._id, 'reads.userId': userId },
    { $max: { 'reads.$.at': at } },
    { session },
  );
  if (updated.matchedCount === 0) {
    await ThreadModel.updateOne(
      { _id: thread._id, 'reads.userId': mongoose.trusted({ $ne: userId }) },
      { $push: { reads: { userId, at } } },
      { session },
    );
  }
  await MessageModel.updateMany(
    {
      threadId: thread._id,
      senderId: mongoose.trusted({ $exists: true, $ne: userId }),
      readAt: mongoose.trusted({ $exists: false }),
      createdAt: mongoose.trusted({ $lte: at }),
    },
    { $set: { readAt: at } },
    { session },
  );
}

/**
 * POST /threads/{ref}/messages: a message from the Guest or Host, with up to 6 photos. The recipient is
 * emailed if it's still unread after 10 minutes (and texted, if they asked for that).
 */
export async function sendMessage(
  actor: Actor,
  ref: string,
  input: SendMessageInput,
  now = new Date(),
): Promise<MessageView> {
  const access = await openThreadFor(actor, ref);
  // A suspended account sends nothing (plan §8.2), whichever conversation it is.
  const sender = await UserModel.findById(actor.userId).select('status').lean();
  if (sender?.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', SUSPENDED_SENDER);
  const state = await detail(access, actor.userId, now);
  if (!state.canSend)
    throw new HttpError(409, 'THREAD_CLOSED', state.readOnlyReason ?? 'Messages can’t be sent here.');
  const { booking, viewer, thread } = access;
  const attachments = await confirmBookingFiles('MESSAGE_PHOTO', booking.id, input.attachments);
  const recipientId = viewer === 'GUEST' ? booking.hostId : booking.guestId;

  const message = await withTransaction(async (session) => {
    const [created] = await MessageModel.create(
      [
        {
          threadId: thread._id,
          senderId: actor.userId,
          body: input.body,
          attachments,
          systemGenerated: false,
        },
      ],
      { session },
    );
    await ThreadModel.updateOne(
      { _id: thread._id },
      { $max: { lastMessageAt: created!.createdAt } },
      { session },
    );
    // Writing a message means they've read the conversation so far.
    await markRead(thread, actor.userId, created!.createdAt, session);
    const fresh = await ThreadModel.findById(thread._id).session(session).lean<ThreadRecord>();
    const since = readAtFor(fresh!, recipientId)?.getTime() ?? 0;
    await enqueue(
      'messages.unreadEmail',
      { threadId: thread.id, recipientId: recipientId.toString() },
      {
        runAt: new Date(created!.createdAt.getTime() + UNREAD_EMAIL_DELAY_MS),
        uniqueKey: `unread-email:${thread.id}:${recipientId.toString()}:${since}`,
        refId: booking.id,
        session,
      },
    );
    const record = created!.toObject() as MessageRecord;
    afterCommit(session, () => emitMessage(booking.toObject() as BookingRecord, record));
    return record;
  });
  return toMessageView(message, booking, viewer, actor.userId);
}

/** POST /threads/{ref}/read: the participant has read the conversation; the other side sees "Seen". */
export async function readThread(actor: Actor, ref: string, now = new Date()): Promise<void> {
  const { booking, viewer, thread } = await openThreadFor(actor, ref);
  await markRead(thread, actor.userId, now);
  const otherId = viewer === 'GUEST' ? booking.hostId : booking.guestId;
  emitToUser(otherId.toString(), 'thread:read', { ref: booking.ref, at: now.toISOString() });
  emitToUser(actor.userId, 'thread:read', { ref: booking.ref, at: now.toISOString(), self: true });
}

/**
 * `messages.unreadEmail` (plan §4.3): 10 minutes after a message, the recipient is emailed (and texted,
 * if they asked) when the conversation is still unread. Returns the unread messages it reported.
 */
export async function unreadMessagesFor(threadId: string, recipientId: string) {
  const thread = await ThreadModel.findById(threadId).lean<ThreadRecord>();
  if (!thread) return null;
  const booking = await BookingModel.findById(thread.bookingId).lean<BookingRecord>();
  if (!booking) return null;
  const since = readAtFor(thread, recipientId) ?? new Date(0);
  // A message support removed isn't sent on by email or text.
  const unread = await MessageModel.find({
    threadId: thread._id,
    senderId: mongoose.trusted({ $exists: true, $ne: new mongoose.Types.ObjectId(recipientId) }),
    createdAt: mongoose.trusted({ $gt: since }),
    hiddenAt: mongoose.trusted({ $exists: false }),
  })
    .sort({ createdAt: 1 })
    .lean<MessageRecord[]>();
  if (unread.length === 0) return null;
  const viewer: Viewer = booking.guestId.equals(recipientId) ? 'GUEST' : 'HOST';
  const latest = toMessageView(unread.at(-1)!, booking, viewer, recipientId);
  return { booking, viewer, count: unread.length, latest, since };
}

/**
 * GET /admin/bookings/{id}/thread: support staff read a booking's messages, only from a report, incident
 * or support ticket about it, and each opening is written to the audit log (plan §6.2).
 */
export async function openThreadForStaff(
  staffId: string,
  roles: Actor['roles'],
  ref: string,
  context: string,
  ip?: string,
) {
  const { booking, viewer } = await findBookingFor({ userId: staffId, roles }, ref);
  if (viewer !== 'STAFF') throw new HttpError(403, 'FORBIDDEN', 'Only support staff open threads here.');
  const [kind, key] = [
    context.slice(0, context.indexOf(':')).toUpperCase(),
    context.slice(context.indexOf(':') + 1),
  ];

  let allowed = false;
  if (kind === 'INCIDENT') {
    allowed = Boolean(await IncidentModel.exists({ caseRef: key.toUpperCase(), bookingId: booking._id }));
  } else if (kind === 'TICKET') {
    allowed = Boolean(await SupportTicketModel.exists({ ref: key.toUpperCase(), bookingId: booking._id }));
  } else if (kind === 'REPORT' && mongoose.isValidObjectId(key)) {
    const report = await ReportModel.findById(key).lean();
    if (report?.targetType === 'MESSAGE') {
      const message = await MessageModel.findById(report.targetId).select('threadId').lean();
      const thread = message ? await ThreadModel.findById(message.threadId).select('bookingId').lean() : null;
      allowed = Boolean(thread?.bookingId.equals(booking._id));
    } else if (report?.targetType === 'USER') {
      // Only the conversation the member was reported from: a report made elsewhere opens no thread.
      allowed =
        Boolean(report.bookingId?.equals(booking._id)) &&
        (booking.guestId.equals(report.targetId) || booking.hostId.equals(report.targetId));
    }
  }
  if (!allowed) {
    throw new HttpError(403, 'NO_CONTEXT', 'That report, incident or ticket isn’t about this booking.');
  }

  const thread = await ensureThread(booking);
  await recordAudit({
    actorId: staffId,
    action: 'thread.opened',
    entity: 'booking',
    entityId: booking.id,
    after: { context: `${kind}:${key.toUpperCase()}` },
    ...(ip && { ip }),
  });
  const now = new Date();
  const settings = await getPlatformSettings();
  const [summary] = await toSummaries([thread.toObject() as ThreadRecord], booking.hostId.toString(), now);
  const messages = await MessageModel.find({ threadId: thread._id })
    .sort({ createdAt: 1 })
    .limit(1000)
    .lean<MessageRecord[]>();
  const [guest, host] = await Promise.all([
    UserModel.findById(booking.guestId).select('firstName').lean(),
    UserModel.findById(booking.hostId).select('firstName').lean(),
  ]);
  const closes = closesAt(booking.toObject() as BookingRecord, settings.trips.threadReadOnlyDays);
  return {
    thread: {
      ...summary!,
      role: 'STAFF' as const,
      canSend: false,
      readOnlyReason: 'Support staff read threads; they reply through the incident or ticket.',
      blockedByMe: false,
      contactsHidden: false,
      closesAt: closes.toISOString(),
    },
    guest: { id: booking.guestId.toString(), firstName: guest?.firstName ?? 'Former member' },
    host: { id: booking.hostId.toString(), firstName: host?.firstName ?? 'Former member' },
    messages: messages.map((message) => toMessageView(message, booking, 'STAFF', staffId)),
  };
}

/**
 * POST /admin/moderation/messages/{id}/remove: support remove a member's message, usually one reported to
 * them. Both sides then see a notice in its place, in the conversation, the inbox and any later email;
 * staff still see the original, marked removed. Written to the audit log with the reason.
 */
export async function removeMessage(staffId: string, messageId: string, reason: string, ip?: string) {
  const message = mongoose.isValidObjectId(messageId)
    ? await MessageModel.findById(messageId).lean<MessageRecord>()
    : null;
  if (!message) throw new HttpError(404, 'NOT_FOUND', 'No such message.');
  if (!message.senderId)
    throw new HttpError(409, 'SYSTEM_MESSAGE', 'Rento Vroom’s own booking messages can’t be removed.');
  if (message.hiddenAt) throw new HttpError(409, 'ALREADY_REMOVED', 'This message has already been removed.');
  // Staff act on a message someone reported (plan §6.2: staff see a conversation only from a report, an
  // incident or a ticket), so a message id alone opens nothing.
  if (!(await ReportModel.exists({ targetType: 'MESSAGE', targetId: message._id }))) {
    throw new HttpError(
      409,
      'NOT_REPORTED',
      'Only a reported message can be removed. Open it from its report.',
    );
  }
  const thread = await ThreadModel.findById(message.threadId).select('bookingId').lean();
  const booking = thread && (await BookingModel.findById(thread.bookingId).lean<BookingRecord>());
  if (!booking) throw new HttpError(404, 'NOT_FOUND', 'No such message.');

  const hiddenAt = new Date();
  const removed = await MessageModel.findOneAndUpdate(
    { _id: message._id, hiddenAt: mongoose.trusted({ $exists: false }) },
    { $set: { hiddenAt, hiddenBy: new mongoose.Types.ObjectId(staffId), hiddenReason: reason } },
    { new: true },
  ).lean<MessageRecord>();
  if (!removed) throw new HttpError(409, 'ALREADY_REMOVED', 'This message has already been removed.');
  await recordAudit({
    actorId: staffId,
    action: 'message.removed',
    entity: 'message',
    entityId: message._id.toString(),
    // Not the words themselves: they stay on the message, which the retention rules delete in time.
    after: { bookingRef: booking.ref, senderId: message.senderId.toString(), reason },
    ...(ip && { ip }),
  });
  // The words also left the message in the recipient's "new message" notice: that goes too.
  const recipient = message.senderId.equals(booking.guestId) ? booking.hostId : booking.guestId;
  const notices = {
    userId: recipient,
    type: 'NEW_MESSAGE',
    createdAt: mongoose.trusted({ $gte: message.createdAt }),
  };
  await NotificationModel.updateMany(
    { ...notices, channel: 'IN_APP', 'payload.link': `/messages/${booking.ref}` },
    { $set: { 'payload.body': REMOVED_MESSAGE_NOTICE } },
  );
  await NotificationModel.updateMany(
    { ...notices, channel: 'EMAIL', 'payload.props.ref': booking.ref },
    { $set: { 'payload.props.snippet': REMOVED_MESSAGE_NOTICE } },
  );
  // Open conversations swap it for the notice straight away.
  emitMessage(booking, removed);
  return { id: removed._id.toString(), removed: true as const };
}
