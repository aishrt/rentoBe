import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { UserModel } from './user.model.js';

/*
 * Notification preferences (plan §7): booking and account messages always go out; marketing email and
 * SMS only with consent (NZ Unsolicited Electronic Messages Act 2007), and texts for unread messages
 * only when asked for. Every marketing email carries an unsubscribe link that works without signing in.
 */

export const notificationPrefsSchema = z
  .object({
    marketingEmail: z.boolean().meta({ description: 'News and offers by email' }),
    marketingSms: z.boolean().meta({ description: 'News and offers by text' }),
    unreadMessageSms: z.boolean().meta({ description: 'A text when a message is unread after 10 minutes' }),
  })
  .meta({ id: 'NotificationPrefs' });
export type NotificationPrefsView = z.infer<typeof notificationPrefsSchema>;

export const notificationPrefsPatchSchema = notificationPrefsSchema
  .partial()
  .meta({ id: 'NotificationPrefsPatch' });

export const unsubscribeSchema = z
  .object({ token: z.string().min(10).max(200) })
  .meta({ id: 'UnsubscribeRequest' });

const key = () => createHash('sha256').update(`unsubscribe:${env.ENCRYPTION_KEY}`).digest();
const sign = (userId: string) => createHmac('sha256', key()).update(userId).digest('base64url');

/** The token in a marketing email's unsubscribe link: the user's id, signed. */
export function unsubscribeToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/** The unsubscribe link for a marketing email (plan §7). */
export function unsubscribeUrl(userId: string): string {
  return `${env.FRONTEND_URL.replace(/\/+$/, '')}/unsubscribe?token=${unsubscribeToken(userId)}`;
}

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefsView> {
  const user = await UserModel.findById(userId).select('notificationPrefs').lean();
  return {
    marketingEmail: user?.notificationPrefs?.marketingEmail ?? false,
    marketingSms: user?.notificationPrefs?.marketingSms ?? false,
    unreadMessageSms: user?.notificationPrefs?.unreadMessageSms ?? false,
  };
}

/** PATCH /me/notification-prefs: changes only the choices sent. */
export async function updateNotificationPrefs(
  userId: string,
  patch: Partial<NotificationPrefsView>,
): Promise<NotificationPrefsView> {
  const set = Object.fromEntries(
    Object.entries(patch).map(([name, value]) => [`notificationPrefs.${name}`, value]),
  );
  if (Object.keys(set).length > 0) await UserModel.updateOne({ _id: userId }, { $set: set });
  return getNotificationPrefs(userId);
}

/**
 * POST /notifications/unsubscribe: the link in a marketing email turns off marketing email and SMS, without
 * signing in, straight away (well within the 5 working days the law allows).
 */
export async function unsubscribe(token: string): Promise<void> {
  const [userId, signature] = token.split('.');
  const expected = userId ? sign(userId) : '';
  const valid =
    Boolean(userId && signature) &&
    signature!.length === expected.length &&
    timingSafeEqual(Buffer.from(signature!), Buffer.from(expected));
  if (!valid)
    throw new HttpError(
      400,
      'INVALID_LINK',
      'This unsubscribe link isn’t valid. Change your choices in your account instead.',
    );
  await UserModel.updateOne(
    { _id: userId },
    { $set: { 'notificationPrefs.marketingEmail': false, 'notificationPrefs.marketingSms': false } },
  );
}
