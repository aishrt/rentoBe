import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { UserModel } from './user.model.js';

/*
 * Notification preferences (plan §7): booking and account messages always go out; marketing email and
 * SMS only with consent (NZ Unsolicited Electronic Messages Act 2007), texts for unread messages only when
 * asked for, and emails about unread messages unless turned off (the non-essential email people choose).
 * Every marketing email, and each unread-message email, carries an unsubscribe link that works without
 * signing in, and a List-Unsubscribe header (plan §7, deliverability).
 */

export const notificationPrefsSchema = z
  .object({
    marketingEmail: z.boolean().meta({ description: 'News and offers by email' }),
    marketingSms: z.boolean().meta({ description: 'News and offers by text' }),
    unreadMessageSms: z.boolean().meta({ description: 'A text when a message is unread after 10 minutes' }),
    unreadMessageEmail: z
      .boolean()
      .meta({ description: 'An email when a message is unread after 10 minutes (on unless turned off)' }),
  })
  .meta({ id: 'NotificationPrefs' });
export type NotificationPrefsView = z.infer<typeof notificationPrefsSchema>;

export const notificationPrefsPatchSchema = notificationPrefsSchema
  .partial()
  .meta({ id: 'NotificationPrefsPatch' });

export const unsubscribeSchema = z
  .object({ token: z.string().min(10).max(200) })
  .meta({ id: 'UnsubscribeRequest' });

export const unsubscribeResponseSchema = z
  .object({ unsubscribedFrom: z.enum(['MARKETING', 'MESSAGE_EMAILS']) })
  .meta({ id: 'UnsubscribeResponse' });

/** What an unsubscribe link turns off: marketing email and texts, or the emails about unread messages. */
export type UnsubscribeScope = 'MARKETING' | 'MESSAGE_EMAILS';

const key = () => createHash('sha256').update(`unsubscribe:${env.ENCRYPTION_KEY}`).digest();
// A marketing token signs the id alone, as the first links did; other scopes sign the scope too.
const sign = (userId: string, scope: UnsubscribeScope = 'MARKETING') =>
  createHmac('sha256', key())
    .update(scope === 'MARKETING' ? userId : `${userId}:${scope}`)
    .digest('base64url');

/** The token in an unsubscribe link: the user's id (and what it turns off, unless marketing), signed. */
export function unsubscribeToken(userId: string, scope: UnsubscribeScope = 'MARKETING'): string {
  return scope === 'MARKETING' ? `${userId}.${sign(userId)}` : `${userId}.${scope}.${sign(userId, scope)}`;
}

/** The unsubscribe page's link (plan §7), for the email's own text. */
export function unsubscribeUrl(userId: string, scope: UnsubscribeScope = 'MARKETING'): string {
  return `${env.FRONTEND_URL.replace(/\/+$/, '')}/unsubscribe?token=${unsubscribeToken(userId, scope)}`;
}

/**
 * The List-Unsubscribe header's link (RFC 8058): the API itself, so an email app's one-click unsubscribe
 * (a POST with no browser) works.
 */
export function oneClickUnsubscribeUrl(userId: string, scope: UnsubscribeScope = 'MARKETING'): string {
  return `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/notifications/unsubscribe?token=${unsubscribeToken(userId, scope)}`;
}

export async function getNotificationPrefs(userId: string): Promise<NotificationPrefsView> {
  const user = await UserModel.findById(userId).select('notificationPrefs').lean();
  return {
    marketingEmail: user?.notificationPrefs?.marketingEmail ?? false,
    marketingSms: user?.notificationPrefs?.marketingSms ?? false,
    unreadMessageSms: user?.notificationPrefs?.unreadMessageSms ?? false,
    unreadMessageEmail: user?.notificationPrefs?.unreadMessageEmail ?? true,
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
 * POST /notifications/unsubscribe: an unsubscribe link turns off what it's for without signing in, straight
 * away (well within the 5 working days the law allows): marketing email and SMS, or unread-message emails.
 */
export async function unsubscribe(token: string): Promise<UnsubscribeScope> {
  const parts = token.split('.');
  const [userId, scopeOrSignature, maybeSignature] = parts;
  const scope: UnsubscribeScope | null =
    parts.length === 2 ? 'MARKETING' : scopeOrSignature === 'MESSAGE_EMAILS' ? 'MESSAGE_EMAILS' : null;
  const signature = parts.length === 2 ? scopeOrSignature : maybeSignature;
  const expected = Buffer.from(userId && scope ? sign(userId, scope) : '');
  // Compared as bytes: a tampered link may hold characters longer than one byte.
  const given = Buffer.from(signature ?? '');
  const valid =
    parts.length <= 3 &&
    // A token reshuffled into a signed "id" that isn't one (e.g. "<id>:MESSAGE_EMAILS") is refused here.
    mongoose.isValidObjectId(userId) &&
    Boolean(userId && scope && signature) &&
    given.length === expected.length &&
    timingSafeEqual(given, expected);
  if (!valid)
    throw new HttpError(
      400,
      'INVALID_LINK',
      'This unsubscribe link isn’t valid. Change your choices in your account instead.',
    );
  await UserModel.updateOne(
    { _id: userId },
    {
      $set:
        scope === 'MESSAGE_EMAILS'
          ? { 'notificationPrefs.unreadMessageEmail': false }
          : { 'notificationPrefs.marketingEmail': false, 'notificationPrefs.marketingSms': false },
    },
  );
  return scope!;
}
