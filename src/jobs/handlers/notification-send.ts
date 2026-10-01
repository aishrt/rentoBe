import { sendEmail } from '../../emails/index.js';
import { SmsNotConfiguredError, getSmsSender } from '../../integrations/sms/sms-sender.js';
import { NotificationModel } from '../../modules/notifications/notification.model.js';
import type { EmailContent } from '../../modules/notifications/notify.js';
import { UserModel } from '../../modules/users/user.model.js';
import type { JobContext } from './index.js';

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
    .select('email phone phoneVerifiedAt closedAt')
    .lean();
  if (!user || user.closedAt) return fail('The account is closed');

  try {
    let providerRef: string;
    if (notification.channel === 'EMAIL') {
      const sent = await sendEmail({
        to: user.email,
        ...(notification.payload as EmailContent),
      } as Parameters<typeof sendEmail>[0]);
      providerRef = sent.id;
    } else if (notification.channel === 'SMS') {
      if (!user.phone || !user.phoneVerifiedAt) return fail('No verified mobile number');
      providerRef = await getSmsSender().send(user.phone, (notification.payload as { body: string }).body);
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
