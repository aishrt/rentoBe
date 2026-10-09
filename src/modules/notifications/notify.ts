import type { ClientSession, Types } from 'mongoose';
import { afterCommit } from '../../db.js';
import type { EmailTemplateName, EmailTemplateProps } from '../../emails/index.js';
import { enqueue } from '../../jobs/queue.js';
import { fromNzWallClock, toNzWallClock, addNzDays } from '../../lib/nz-time.js';
import { emitToUser } from '../../realtime/realtime.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import type { BookingStatus } from '../bookings/booking.model.js';
import { UserModel } from '../users/user.model.js';
import { NotificationModel } from './notification.model.js';

/*
 * notify() (plan §7): one call per event and person. It writes the in-app notification the bell
 * shows, and queues the email and, when asked, an SMS to a verified mobile. Pass the caller's
 * transaction so the notifications exist only if the change behind them commits.
 */

/** An email template with its own props, so notify() checks them against the template. */
export type EmailContent = {
  [Name in EmailTemplateName]: { template: Name; props: EmailTemplateProps<Name> };
}[EmailTemplateName];

export interface SmsContent {
  body: string;
  /** Sent straight away, even in quiet hours. */
  urgent?: boolean;
  /**
   * A text that waits for the end of quiet hours can be out of date by then. It's dropped if the booking it's
   * about is no longer in one of these statuses (e.g. a request already answered or cancelled)…
   */
  whileBooking?: { id: Types.ObjectId | string; statuses: readonly BookingStatus[] };
  /** …if it would arrive after this time (e.g. a reminder for a pickup that's already passed)… */
  expiresAt?: Date;
  /** …or, for a new-message text, if the person has read the conversation since. */
  whileUnread?: { threadId: Types.ObjectId | string };
}

/** What an SMS notification stores, and what `notification.send` checks before sending it. */
export interface SmsPayload {
  body: string;
  whileBooking?: { id: string; statuses: BookingStatus[] };
  expiresAt?: Date;
  whileUnread?: { threadId: string };
}

export interface NotifyInput {
  userId: Types.ObjectId | string;
  /** E.g. BOOKING_CONFIRMED. */
  type: string;
  /** The notification centre's line, e.g. "Booking confirmed: 2022 Toyota RAV4". */
  title: string;
  body?: string;
  /** A website path to open, e.g. /trips/RV-7K2Q9M. */
  link?: string;
  email?: EmailContent;
  /** Sent only to a verified mobile. Non-urgent messages wait for the end of quiet hours (plan §7). */
  sms?: SmsContent;
  /** One event's notifications are sent once, however often the code behind them runs. */
  dedupeKey?: string;
}

const minutesOf = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours! * 60 + minutes!;
};

/** When a non-urgent SMS may go: now, or at the end of quiet hours (9 pm to 7 am by default). */
export function smsSendTime(now: Date, quietStart: string, quietEnd: string): Date {
  const wall = toNzWallClock(now);
  const minute = wall.hour * 60 + wall.minute;
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);
  const quiet = start > end ? minute >= start || minute < end : minute >= start && minute < end;
  if (!quiet) return now;
  const day = minute >= end ? addNzDays(now, 1) : now;
  const { year, month, day: date } = toNzWallClock(day);
  return fromNzWallClock(year, month, date, Math.floor(end / 60), end % 60);
}

export async function notify(
  input: NotifyInput,
  { session, now = new Date() }: { session?: ClientSession; now?: Date } = {},
) {
  if (
    input.dedupeKey &&
    (await NotificationModel.exists({ dedupeKey: input.dedupeKey }).session(session ?? null))
  ) {
    return;
  }
  const user = await UserModel.findById(input.userId)
    .select('email phone phoneVerifiedAt closedAt')
    .session(session ?? null)
    .lean();
  if (!user || user.closedAt) return;

  const base = { userId: user._id, type: input.type, ...(input.dedupeKey && { dedupeKey: input.dedupeKey }) };
  const [inApp] = await NotificationModel.create(
    [
      {
        ...base,
        channel: 'IN_APP',
        status: 'SENT',
        sentAt: now,
        payload: {
          title: input.title,
          ...(input.body && { body: input.body }),
          ...(input.link && { link: input.link }),
        },
      },
    ],
    { session },
  );

  if (input.email) {
    const [email] = await NotificationModel.create(
      [{ ...base, channel: 'EMAIL', status: 'QUEUED', payload: input.email }],
      { session },
    );
    await enqueue(
      'notification.send',
      { notificationId: email!.id },
      { uniqueKey: `notification:${email!.id}`, session },
    );
  }

  if (input.sms && user.phone && user.phoneVerifiedAt) {
    const settings = await getPlatformSettings();
    const runAt = input.sms.urgent
      ? now
      : smsSendTime(now, settings.sms.quietHoursStart, settings.sms.quietHoursEnd);
    const { whileBooking, expiresAt, whileUnread } = input.sms;
    const payload: SmsPayload = {
      body: input.sms.body,
      ...(whileBooking && {
        whileBooking: { id: whileBooking.id.toString(), statuses: [...whileBooking.statuses] },
      }),
      ...(expiresAt && { expiresAt }),
      ...(whileUnread && { whileUnread: { threadId: whileUnread.threadId.toString() } }),
    };
    const [sms] = await NotificationModel.create([{ ...base, channel: 'SMS', status: 'QUEUED', payload }], {
      session,
    });
    await enqueue(
      'notification.send',
      { notificationId: sms!.id },
      { uniqueKey: `notification:${sms!.id}`, runAt, session },
    );
  }

  // The bell updates live once the change behind the notification is saved (plan §7, build order).
  afterCommit(session, () =>
    emitToUser(user._id.toString(), 'notification', { id: inApp!.id, type: input.type, title: input.title }),
  );
}
