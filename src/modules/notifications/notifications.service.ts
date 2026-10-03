import mongoose from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { NotificationModel, type Notification } from './notification.model.js';

/*
 * The notification centre (plan §7): the in-app notifications behind the header's bell and the
 * Notifications page. Every query is the signed-in user's own IN_APP ones, never anyone else's.
 */

/** The user's own in-app notifications that they haven't deleted. */
const own = (userId: string) => ({
  userId,
  channel: 'IN_APP' as const,
  deletedAt: mongoose.trusted({ $exists: false }),
});
const unread = { readAt: mongoose.trusted({ $exists: false }) };
const read = { readAt: mongoose.trusted({ $exists: true }) };
const withIds = (ids: string[]) => ({ _id: mongoose.trusted({ $in: ids }) });

export async function notificationCounts(userId: string) {
  const [unreadCount, total] = await Promise.all([
    NotificationModel.countDocuments({ ...own(userId), ...unread }),
    NotificationModel.countDocuments(own(userId)),
  ]);
  return { unreadCount, total };
}

/*
 * A page ends at a notification; the next starts just after it in the newest-first order. The cursor
 * is opaque to clients: the time and id of that last notification.
 */
interface Cursor {
  at: Date;
  id: string;
}

const encodeCursor = ({ at, id }: Cursor) => Buffer.from(`${at.getTime()}:${id}`).toString('base64url');

function decodeCursor(cursor: string): Cursor {
  const match = /^(\d{1,15}):([0-9a-f]{24})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      cursor: 'Unknown cursor. Start again from the first page.',
    });
  }
  return { at: new Date(Number(match[1])), id: match[2]! };
}

function toItem(item: Notification & { _id: mongoose.Types.ObjectId }) {
  const payload = item.payload as { title?: string; body?: string; link?: string };
  return {
    id: item._id.toString(),
    type: item.type,
    title: payload.title ?? item.type,
    ...(payload.body && { body: payload.body }),
    ...(payload.link && { link: payload.link }),
    createdAt: item.createdAt.toISOString(),
    read: Boolean(item.readAt),
  };
}

export async function listNotifications(
  userId: string,
  options: { limit: number; cursor?: string; unreadOnly?: boolean },
) {
  const after = options.cursor ? decodeCursor(options.cursor) : undefined;
  const filter = {
    ...own(userId),
    ...(options.unreadOnly && unread),
    // Older than the cursor, or as old with a lower id: the index keeps both in order.
    ...(after && {
      createdAt: mongoose.trusted({ $lte: after.at }),
      $or: [
        { createdAt: mongoose.trusted({ $lt: after.at }) },
        { _id: mongoose.trusted({ $lt: new mongoose.Types.ObjectId(after.id) }) },
      ],
    }),
  };
  const [items, counts] = await Promise.all([
    NotificationModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(options.limit + 1)
      .lean(),
    notificationCounts(userId),
  ]);
  const page = items.slice(0, options.limit);
  const last = page.at(-1);
  return {
    notifications: page.map(toItem),
    ...counts,
    ...(items.length > options.limit &&
      last && { nextCursor: encodeCursor({ at: last.createdAt, id: last._id.toString() }) }),
  };
}

/** Marks some of the user's notifications read, or all of them without ids. */
export async function markRead(userId: string, ids?: string[]) {
  await NotificationModel.updateMany(
    { ...own(userId), ...unread, ...(ids && withIds(ids)) },
    { $set: { readAt: new Date() } },
  );
  return notificationCounts(userId);
}

export async function markUnread(userId: string, ids: string[]) {
  await NotificationModel.updateMany({ ...own(userId), ...read, ...withIds(ids) }, { $unset: { readAt: 1 } });
  return notificationCounts(userId);
}

/**
 * Deletes some of the user's notifications, or every one they've read. They are only hidden: notify()
 * finds an event's notifications by their dedupeKey, and must still find a deleted one.
 */
export async function deleteNotifications(userId: string, target: { ids: string[] } | { read: true }) {
  const { modifiedCount } = await NotificationModel.updateMany(
    { ...own(userId), ...('ids' in target ? withIds(target.ids) : read) },
    { $set: { deletedAt: new Date() } },
  );
  return { deleted: modifiedCount, ...(await notificationCounts(userId)) };
}

/**
 * Deletes one notification. Deleting one again is fine; one that isn't the user's (or isn't in-app)
 * is a 404, the same as one that doesn't exist.
 */
export async function deleteNotification(userId: string, id: string) {
  const mine = mongoose.isValidObjectId(id)
    ? await NotificationModel.findOne({ _id: id, userId, channel: 'IN_APP' }).select('deletedAt').lean()
    : null;
  if (!mine) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that notification.");
  if (!mine.deletedAt) {
    await NotificationModel.updateOne({ _id: mine._id, ...own(userId) }, { $set: { deletedAt: new Date() } });
  }
}
