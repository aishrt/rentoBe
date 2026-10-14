import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../../env.js';
import { logger } from '../../integrations/logger.js';
import { twilioStatusCallbackUrl } from '../../integrations/sms/sms-sender.js';
import { HttpError } from '../../lib/http-error.js';
import { UserModel, type EmailProblem } from '../users/user.model.js';
import { NotificationModel } from './notification.model.js';

/*
 * Delivery status from the email and SMS providers (plan §7, §11): POST /api/v1/webhooks/resend and
 * /api/v1/webhooks/twilio. Each finds the notification by the provider's message id (`providerRef`) and moves
 * it from SENT to DELIVERED or FAILED. A bounced address is recorded on the person's record for staff, and
 * a spam complaint turns off their marketing emails. Both providers retry a delivery that fails, and every
 * update here can safely run twice.
 */

/** The Resend events the webhook subscribes to (Resend → Webhooks, DEPLOYING_UPDATES.md "Email delivery"). */
export const RESEND_WEBHOOK_EVENTS = [
  'email.delivered',
  'email.bounced',
  'email.failed',
  'email.suppressed',
  'email.complained',
] as const;

const invalidSignature = () => new HttpError(400, 'INVALID_SIGNATURE', 'The webhook signature is not valid.');

/** Resend signs its webhooks the Standard Webhooks way: HMAC-SHA256 of `id.timestamp.body`. */
const RESEND_TOLERANCE_SECONDS = 5 * 60;

export function verifyResendSignature(
  body: Buffer,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  now = Date.now(),
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) throw invalidSignature();
  if (Math.abs(now / 1000 - Number(timestamp)) > RESEND_TOLERANCE_SECONDS) throw invalidSignature();

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  // The header lists one or more "v1,<base64>" signatures, separated by spaces (several during a key rotation).
  const matches = signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw invalidSignature();
}

/** Twilio signs the full callback URL followed by each form field's name and value, sorted by name. */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((text, name) => text + name + params[name], url);
  return createHmac('sha1', authToken).update(data).digest('base64');
}

function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined) {
  if (!signature) throw invalidSignature();
  const expected = Buffer.from(twilioSignature(url, params, env.TWILIO_AUTH_TOKEN!));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalidSignature();
}

/**
 * Records a provider's outcome. Statuses only move forward: QUEUED or SENT → DELIVERED or FAILED, and a
 * late bounce turns DELIVERED into FAILED; a delivery report never undoes a failure.
 */
export async function recordDelivery(
  channel: 'EMAIL' | 'SMS',
  providerRef: string,
  outcome: 'DELIVERED' | 'FAILED',
  error?: string,
): Promise<boolean> {
  const from = outcome === 'DELIVERED' ? ['QUEUED', 'SENT'] : ['QUEUED', 'SENT', 'DELIVERED'];
  const result = await NotificationModel.updateOne(
    { providerRef, channel, status: mongoose.trusted({ $in: from }) },
    outcome === 'DELIVERED'
      ? { $set: { status: 'DELIVERED' } }
      : { $set: { status: 'FAILED', error: error ?? 'Not delivered' } },
  );
  return result.modifiedCount > 0;
}

interface ResendEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    bounce?: { type?: string; subType?: string; message?: string };
    failed?: { reason?: string };
    suppressed?: { type?: string; message?: string };
  };
}

/** Applies one verified Resend event. Exported for tests. */
export async function applyResendEvent(event: ResendEvent): Promise<void> {
  const emailId = event.data?.email_id;
  const recipients = (event.data?.to ?? []).map((address) => address.trim().toLowerCase());
  const at =
    event.created_at && !Number.isNaN(Date.parse(event.created_at)) ? new Date(event.created_at) : new Date();

  const markProblem = async (problem: Omit<EmailProblem, 'at'>) => {
    if (recipients.length === 0) return;
    // Only a newer problem replaces the one on record, so retries and late events keep the latest.
    await UserModel.updateMany(
      {
        email: mongoose.trusted({ $in: recipients }),
        $or: [
          { emailProblem: mongoose.trusted({ $exists: false }) },
          { 'emailProblem.at': mongoose.trusted({ $lte: at }) },
        ],
      },
      { $set: { emailProblem: { ...problem, at } } },
    );
  };

  switch (event.type) {
    case 'email.delivered': {
      if (emailId) await recordDelivery('EMAIL', emailId, 'DELIVERED');
      // The address works again: a bounce recorded before this delivery no longer applies.
      if (recipients.length > 0) {
        await UserModel.updateMany(
          { email: mongoose.trusted({ $in: recipients }), 'emailProblem.at': mongoose.trusted({ $lt: at }) },
          { $unset: { emailProblem: 1 } },
        );
      }
      return;
    }
    case 'email.bounced': {
      const bounce = event.data?.bounce;
      const detail = [bounce?.type, bounce?.subType].filter(Boolean).join(', ');
      const reason = [detail && `(${detail})`, bounce?.message].filter(Boolean).join(' ');
      if (emailId) await recordDelivery('EMAIL', emailId, 'FAILED', `Bounced${reason ? ` ${reason}` : ''}`);
      await markProblem({ kind: 'BOUNCED', ...(reason && { detail: reason.slice(0, 500) }) });
      return;
    }
    case 'email.suppressed': {
      const message = event.data?.suppressed?.message ?? event.data?.suppressed?.type;
      if (emailId) {
        await recordDelivery(
          'EMAIL',
          emailId,
          'FAILED',
          `Not sent: the address is suppressed${message ? ` (${message})` : ''}`,
        );
      }
      await markProblem({ kind: 'SUPPRESSED', ...(message && { detail: message.slice(0, 500) }) });
      return;
    }
    case 'email.failed': {
      if (emailId)
        await recordDelivery(
          'EMAIL',
          emailId,
          'FAILED',
          event.data?.failed?.reason ?? 'Resend could not send it',
        );
      return;
    }
    case 'email.complained': {
      // Marked as spam: no more marketing emails to them (Unsolicited Electronic Messages Act, plan §7).
      // Booking and account emails still go.
      if (recipients.length > 0) {
        await UserModel.updateMany(
          { email: mongoose.trusted({ $in: recipients }) },
          { $set: { 'notificationPrefs.marketingEmail': false } },
        );
      }
      return;
    }
    default:
      return;
  }
}

/** Twilio's final statuses; the others (queued, sending, sent, …) change nothing here. */
const TWILIO_FAILED = new Set(['failed', 'undelivered']);

export function deliveryWebhooksRouter() {
  const router = Router();

  // Resend signs the raw body, so this route reads it unparsed (the JSON parser comes after this router).
  router.post('/resend', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const secret = env.RESEND_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, 'WEBHOOK_UNAVAILABLE', 'The Resend webhook secret is not set.');
    if (!Buffer.isBuffer(req.body)) throw invalidSignature();
    verifyResendSignature(
      req.body,
      {
        id: req.get('svix-id') ?? req.get('webhook-id'),
        timestamp: req.get('svix-timestamp') ?? req.get('webhook-timestamp'),
        signature: req.get('svix-signature') ?? req.get('webhook-signature'),
      },
      secret,
    );
    let event: ResendEvent;
    try {
      event = JSON.parse(req.body.toString('utf8')) as ResendEvent;
    } catch {
      throw new HttpError(400, 'INVALID_BODY', 'The webhook body is not JSON.');
    }
    await applyResendEvent(event);
    res.json({ received: true });
  });

  router.post('/twilio', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    const url = twilioStatusCallbackUrl();
    if (!env.TWILIO_AUTH_TOKEN || !url) {
      throw new HttpError(503, 'WEBHOOK_UNAVAILABLE', 'Twilio status callbacks are not set up.');
    }
    const params = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(([name, value]) => [
        name,
        String(value),
      ]),
    );
    verifyTwilioSignature(url, params, req.get('x-twilio-signature'));

    const sid = params.MessageSid ?? params.SmsSid;
    const status = params.MessageStatus ?? params.SmsStatus;
    if (sid && status === 'delivered') {
      await recordDelivery('SMS', sid, 'DELIVERED');
    } else if (sid && status && TWILIO_FAILED.has(status)) {
      const code = params.ErrorCode ? ` (Twilio error ${params.ErrorCode})` : '';
      await recordDelivery('SMS', sid, 'FAILED', `Text ${status}${code}`);
      logger.warn({ sid, status, errorCode: params.ErrorCode }, 'Text message not delivered');
    }
    // Twilio expects an empty TwiML-free 2xx.
    res.status(204).end();
  });

  return router;
}
