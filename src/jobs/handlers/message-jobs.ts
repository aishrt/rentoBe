import { env } from '../../env.js';
import { unreadMessagesFor } from '../../modules/messages/messages.service.js';
import { notify } from '../../modules/notifications/notify.js';
import { syncIdentity } from '../../modules/users/identity.service.js';
import { UserModel } from '../../modules/users/user.model.js';
import type { JobContext } from './index.js';

const SNIPPET_LENGTH = 160;

/**
 * `messages.unreadEmail` (plan §4.3): 10 minutes after a message, if the recipient still hasn't read the
 * conversation, they're emailed, and texted if they chose that in their notification preferences.
 */
export async function unreadMessageEmailJob(
  { threadId, recipientId }: { threadId: string; recipientId: string },
  { log }: JobContext,
) {
  const unread = await unreadMessagesFor(threadId, recipientId);
  if (!unread) return;
  const { booking, viewer, count, latest, since } = unread;
  const senderId = viewer === 'GUEST' ? booking.hostId : booking.guestId;
  const [recipient, sender] = await Promise.all([
    UserModel.findById(recipientId).select('firstName notificationPrefs').lean(),
    UserModel.findById(senderId).select('firstName').lean(),
  ]);
  if (!recipient) return;
  const senderName = sender?.firstName ?? 'Your host';
  const text = latest.body || (latest.attachments.length > 0 ? 'Sent a photo.' : '');
  const snippet = text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH - 1)}…` : text;
  const path = `/messages/${booking.ref}`;
  const url = `${env.FRONTEND_URL.replace(/\/+$/, '')}${path}`;

  await notify({
    userId: recipientId,
    type: 'NEW_MESSAGE',
    title: count > 1 ? `${count} new messages from ${senderName}` : `New message from ${senderName}`,
    body: snippet,
    link: path,
    email: {
      template: 'newMessage',
      props: {
        firstName: recipient.firstName,
        senderFirstName: senderName,
        vehicleTitle: booking.vehicleSnapshot.title,
        ref: booking.ref,
        snippet,
        count,
        url,
      },
    },
    ...(recipient.notificationPrefs?.unreadMessageSms && {
      sms: {
        body: `Rento Vroom: ${senderName} sent you a message about ${booking.ref}. Read it: ${url}`,
        whileUnread: { threadId },
      },
    }),
    dedupeKey: `NEW_MESSAGE:${threadId}:${recipientId}:${since.getTime()}`,
  });
  log.info({ threadId, recipientId, count }, 'Unread message email sent');
}

/** `identity.sync`: applies Stripe Identity's result to the person, outside the webhook's transaction. */
export async function identitySyncJob(
  { userId, sessionId }: { userId: string; sessionId: string },
  { log }: JobContext,
) {
  const result = await syncIdentity(userId, sessionId);
  log.info({ userId, status: result.status, sessionStatus: result.sessionStatus }, 'Identity check applied');
}
