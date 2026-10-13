import { sendEmail } from '../../emails/index.js';
import { SmsNotConfiguredError, getSmsSender } from '../../integrations/sms/sms-sender.js';
import { BookingModel } from '../../modules/bookings/booking.model.js';
import { unreadMessagesFor } from '../../modules/messages/messages.service.js';
import { NotificationModel } from '../../modules/notifications/notification.model.js';
import type { EmailContent, SmsPayload } from '../../modules/notifications/notify.js';
import { UserModel, type NotificationPrefs } from '../../modules/users/user.model.js';
import type { JobContext } from './index.js';

/**
 * Why a text is no longer worth sending, if it isn't: it waited for the end of quiet hours (plan §7), and in
 * the meantime the person turned that kind of text off, the booking moved on, the time it was about passed,
 * or the message it announces was read or its sender blocked.
 */
async function outdatedReason(
  payload: SmsPayload,
  userId: string,
  prefs: Partial<NotificationPrefs> | undefined,
  now = new Date(),
): Promise<string | null> {
  if (payload.whileOptedIn && prefs?.[payload.whileOptedIn] !== true) return 'Turned off in their settings';
  if (payload.expiresAt && new Date(payload.expiresAt) <= now) return 'Too late to be useful';
  if (payload.whileBooking) {
    const booking = await BookingModel.findById(payload.whileBooking.id).select('status').lean();
    if (!booking || !payload.whileBooking.statuses.includes(booking.status))
      return 'The booking has moved on';
  }
  if (payload.whileUnread) {
    const unread = await unreadMessagesFor(payload.whileUnread.threadId, userId, now);
    if (!unread) return 'The message has been read';
    if (unread.blockedSender) return 'They blocked the sender';
  }
  return null;
}

/**
 * `notification.send` (plan §4.3, §7): delivers one queued email or SMS from notify() and records the
 * outcome on the notification. It skips one that's already sent, so a retry never sends twice.
 */
export async function sendNotificationJob(
  { notificationId }: { notificationId: string },
  { job, log }: JobContext,
) {
  const notification = await NotificationModel.findById(notificationId);
  if (!notification || notification.status !== 'QUEUED') return;

  const fail = async (error: string) => {
    await NotificationModel.updateOne({ _id: notification._id }, { $set: { status: 'FAILED', error } });
  };
  const user = await UserModel.findById(notification.userId)
    .select('email phone phoneVerifiedAt closedAt notificationPrefs')
    .lean();
  if (!user || user.closedAt) return fail('The account is closed');

  try {
    let providerRef: string;
    if (notification.channel === 'EMAIL') {
      const sent = await sendEmail({
        to: user.email,
        ...(notification.payload as EmailContent),
        // A retry after the provider took the email (but before it was marked sent) isn't sent twice.
        idempotencyKey: `notification:${notification.id}`,
      } as Parameters<typeof sendEmail>[0]);
      providerRef = sent.id;
    } else if (notification.channel === 'SMS') {
      if (!user.phone || !user.phoneVerifiedAt) return fail('No verified mobile number');
      const payload = notification.payload as SmsPayload;
      const outdated = await outdatedReason(payload, notification.userId.toString(), user.notificationPrefs);
      if (outdated) {
        await NotificationModel.updateOne(
          { _id: notification._id, status: 'QUEUED' },
          { $set: { status: 'CANCELLED', error: outdated } },
        );
        log.info({ notificationId, type: notification.type, outdated }, 'Text not sent: out of date');
        return;
      }
      providerRef = await getSmsSender().send(user.phone, payload.body);
    } else {
      return;
    }
    await NotificationModel.updateOne(
      { _id: notification._id, status: 'QUEUED' },
      { $set: { status: 'SENT', sentAt: new Date(), providerRef } },
    );
    log.info({ notificationId, channel: notification.channel, type: notification.type }, 'Notification sent');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SmsNotConfiguredError) {
      log.warn({ notificationId }, message);
      return fail(message);
    }
    if (job.attempts >= job.maxAttempts) await fail(message);
    throw error;
  }
}
