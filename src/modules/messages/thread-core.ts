import type { ClientSession, Types } from 'mongoose';
import { afterCommit } from '../../db.js';
import { emitToUser } from '../../realtime/realtime.js';
import type { Booking } from '../bookings/booking.model.js';
import { isConfirmed, type Viewer } from '../bookings/booking-view.js';
import { attachmentView } from '../uploads/upload-folders.js';
import { maskContactDetails } from './masking.js';
import { MessageModel, type Message } from './message.model.js';
import type { MessageView } from './messages.schemas.js';
import { ThreadModel, type Thread, type ThreadDocument } from './thread.model.js';

/*
 * The parts of messaging that other features use: a booking's thread, how a message looks to each
 * viewer, and the automated messages bookings, reminders and the handover post (spec §13).
 */

type Id = Types.ObjectId;
export type BookingRecord = Booking & { _id: Id };
export type ThreadRecord = Thread & { _id: Id };
export type MessageRecord = Message & { _id: Id };

/**
 * Whether a booking has a thread: once it has reached the Host, as a request or a confirmed booking
 * (plan §16, item 13: messaging opens with a booking or request). A checkout that was never paid for
 * never reached them.
 */
export function bookingHasThread(booking: Pick<Booking, 'status' | 'requestExpiresAt' | 'statusHistory'>) {
  if (booking.status === 'PAYMENT_PENDING') return false;
  if (booking.status !== 'EXPIRED') return true;
  return (
    Boolean(booking.requestExpiresAt) || booking.statusHistory.some((change) => change.status === 'PENDING')
  );
}

/** The booking's thread, made the first time it's needed. */
export async function ensureThread(
  booking: Pick<BookingRecord, '_id' | 'guestId' | 'hostId'>,
  session?: ClientSession,
): Promise<ThreadDocument> {
  const thread = await ThreadModel.findOneAndUpdate(
    { bookingId: booking._id },
    { $setOnInsert: { participantIds: [booking.guestId, booking.hostId], reads: [] } },
    { upsert: true, new: true, session },
  );
  return thread!;
}

export const readAtFor = (thread: Pick<Thread, 'reads'>, userId: Id | string) =>
  thread.reads.find((read) => read.userId.equals(userId))?.at;

/** A message as one viewer sees it. Support staff see the booking as it is, contact details included. */
export function toMessageView(
  message: MessageRecord,
  booking: Pick<BookingRecord, 'guestId' | 'hostId' | 'status'>,
  viewer: Viewer,
  viewerId: Id | string,
): MessageView {
  const sender = !message.senderId ? 'SYSTEM' : message.senderId.equals(booking.guestId) ? 'GUEST' : 'HOST';
  const mine = message.senderId?.equals(viewerId) ?? false;
  const hide = viewer !== 'STAFF' && !message.systemGenerated && !isConfirmed(booking.status);
  return {
    id: message._id.toString(),
    from: sender === 'SYSTEM' ? 'SYSTEM' : mine || (viewer === 'STAFF' && sender === 'HOST') ? 'ME' : 'THEM',
    sender,
    body: hide ? maskContactDetails(message.body) : message.body,
    attachments: message.attachments.map(attachmentView),
    createdAt: message.createdAt.toISOString(),
    ...(mine && message.readAt && { readAt: message.readAt.toISOString() }),
  };
}

/** Sends a message's view to each participant's open tabs and devices. */
export function emitMessage(booking: BookingRecord, message: MessageRecord) {
  for (const [userId, viewer] of [
    [booking.guestId, 'GUEST'],
    [booking.hostId, 'HOST'],
  ] as const) {
    emitToUser(userId.toString(), 'message', {
      ref: booking.ref,
      message: toMessageView(message, booking, viewer, userId),
    });
  }
}

/**
 * An automated message from Rento Vroom in the booking's chat (spec §13): the booking confirmed, the
 * pickup and return reminders, the handover. Booking-critical, so it arrives even when one side has
 * blocked the other. Pass the caller's transaction so it exists only if the change behind it commits.
 */
export async function postSystemMessage(
  booking: Pick<BookingRecord, '_id' | 'ref' | 'guestId' | 'hostId' | 'status'>,
  body: string,
  { session, now = new Date() }: { session?: ClientSession; now?: Date } = {},
): Promise<void> {
  const thread = await ensureThread(booking, session);
  const [created] = await MessageModel.create(
    [{ threadId: thread._id, body, attachments: [], systemGenerated: true, createdAt: now }],
    { session },
  );
  await ThreadModel.updateOne(
    { _id: thread._id },
    { $max: { lastMessageAt: created!.createdAt } },
    { session },
  );
  const record = created!.toObject() as MessageRecord;
  afterCommit(session, () => emitMessage(booking as BookingRecord, record));
}
