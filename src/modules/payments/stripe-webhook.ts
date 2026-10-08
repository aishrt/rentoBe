import express, { Router } from 'express';
import mongoose, { type ClientSession } from 'mongoose';
import Stripe from 'stripe';
import { withTransaction } from '../../db.js';
import { env } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { bookingPaymentHandlers } from '../bookings/payment-events.js';
import { applyAccountState } from '../payouts/connect.service.js';
import { queueIdentitySync } from '../users/identity.service.js';
import { StripeEventModel } from './stripe-event.model.js';

type StripeEventType = Stripe.Event['type'];
export type StripeEventHandler = (event: Stripe.Event, session: ClientSession) => Promise<void>;

/**
 * The events the webhook endpoint subscribes to (plan §8.1): payments, refunds and card disputes.
 * `npm run stripe:setup` registers them with Stripe.
 */
export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.closed',
  'identity.verification_session.verified',
  'identity.verification_session.requires_input',
  'identity.verification_session.processing',
  'identity.verification_session.canceled',
] as const satisfies readonly StripeEventType[];

/**
 * Events about Hosts' Connect accounts (plan §8.1, item 20). Stripe sends them to a second endpoint,
 * at the same URL, with its own signing secret (STRIPE_CONNECT_WEBHOOK_SECRET).
 */
export const STRIPE_CONNECT_WEBHOOK_EVENTS = [
  'account.updated',
] as const satisfies readonly StripeEventType[];

/**
 * What each event does. A handler runs inside the transaction that records the event, so it only
 * writes to the database (emails and Stripe calls go through the job queue) and may run twice if
 * MongoDB retries the transaction. Payments for bookings, refunds and disputes are handled in
 * bookings/payment-events.ts; the staff test payment's events are only recorded.
 */
export const stripeEventHandlers: Partial<Record<StripeEventType, StripeEventHandler>> = {
  ...bookingPaymentHandlers,
  'account.updated': (event, session) => applyAccountState(event.data.object as Stripe.Account, session),
  // Identity checks (plan §9, Days 19–20): applied by the `identity.sync` job.
  ...Object.fromEntries(
    (
      [
        'identity.verification_session.verified',
        'identity.verification_session.requires_input',
        'identity.verification_session.processing',
        'identity.verification_session.canceled',
      ] as const
    ).map((type) => [
      type,
      (event: Stripe.Event, session: ClientSession) =>
        queueIdentitySync(event.data.object as Stripe.Identity.VerificationSession, session),
    ]),
  ),
};

/**
 * POST /api/v1/payments/webhook (plan §8.1, item 13). Stripe signs each event with the endpoint's
 * secret and the signature covers the raw body, so this router is mounted before the JSON parser.
 */
export function stripeWebhookRouter() {
  const router = Router();

  router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    const event = verifiedEvent(req.body, req.get('stripe-signature'));
    const firstDelivery = await handleStripeEvent(event);
    res.json({ received: true, duplicate: !firstDelivery });
  });

  return router;
}

function verifiedEvent(body: unknown, signature: string | undefined): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'The Stripe webhook secret is not set.');
  }
  if (!Buffer.isBuffer(body) || !signature) throw invalidSignature();
  // The platform's endpoint, then the Connect endpoint's: both post to this URL.
  for (const secret of [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET]) {
    if (!secret) continue;
    try {
      return Stripe.webhooks.constructEvent(body, signature, secret);
    } catch {
      // Try the other secret.
    }
  }
  throw invalidSignature();
}

const invalidSignature = () =>
  new HttpError(400, 'INVALID_SIGNATURE', 'The Stripe-Signature header is missing or does not match.');

/**
 * Runs the event's handler and saves the event id in one transaction, so a repeated delivery is
 * skipped and a failed one saves nothing (Stripe retries it for up to 3 days). Resolves false for
 * a repeat.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<boolean> {
  const handler = stripeEventHandlers[event.type];
  const object = event.data.object as { id?: unknown };
  try {
    await withTransaction(async (session) => {
      await StripeEventModel.create(
        [
          {
            eventId: event.id,
            type: event.type,
            objectId: typeof object.id === 'string' ? object.id : undefined,
          },
        ],
        { session },
      );
      await handler?.(event, session);
    });
    return true;
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) return false;
    throw error;
  }
}
