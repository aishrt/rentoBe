import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/env.js';
import { StripeEventModel } from '../src/modules/payments/stripe-event.model.js';
import { stripeEventHandlers } from '../src/modules/payments/stripe-webhook.js';
import { testApp } from './helpers.js';

const SECRET = env.STRIPE_WEBHOOK_SECRET!;

function eventPayload(id = 'evt_1', type = 'payment_intent.succeeded') {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    api_version: '2026-08-26.dahlia',
    created: 1_790_000_000,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: { id: 'pi_123', object: 'payment_intent', amount: 100, currency: 'nzd' } },
  });
}

const sign = (payload: string, secret = SECRET) =>
  Stripe.webhooks.generateTestHeaderString({ payload, secret });

/** Posts the body exactly as Stripe does: raw JSON from its servers, with no Origin header. */
function deliver(payload: string, signature: string | null = sign(payload)) {
  const call = request(testApp()).post('/api/v1/payments/webhook').set('Content-Type', 'application/json');
  return (signature ? call.set('Stripe-Signature', signature) : call).send(payload);
}

afterEach(() => {
  delete stripeEventHandlers['payment_intent.succeeded'];
});

describe('Stripe webhook', () => {
  it('records a signed event once and skips a repeated delivery', async () => {
    const payload = eventPayload();

    const first = await deliver(payload);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true, duplicate: false });

    const again = await deliver(payload);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ received: true, duplicate: true });

    const saved = await StripeEventModel.find().lean();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      eventId: 'evt_1',
      type: 'payment_intent.succeeded',
      objectId: 'pi_123',
    });
  });

  it('rejects a missing, wrong or stale signature, and a changed body', async () => {
    const payload = eventPayload();
    const cases = [
      await deliver(payload, null),
      await deliver(payload, sign(payload, 'whsec_someoneelse')),
      await deliver(eventPayload('evt_2'), sign(payload)),
      await deliver(
        payload,
        Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: 1_000_000_000 }),
      ),
    ];
    for (const response of cases) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_SIGNATURE');
    }
    expect(await StripeEventModel.countDocuments()).toBe(0);
  });

  it("saves nothing when the event's handler fails, so Stripe's retry runs it again", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('database hiccup')).mockResolvedValue(undefined);
    stripeEventHandlers['payment_intent.succeeded'] = handler;
    const payload = eventPayload();

    expect((await deliver(payload)).status).toBe(500);
    expect(await StripeEventModel.countDocuments()).toBe(0);

    expect((await deliver(payload)).status).toBe(200);
    expect(await StripeEventModel.countDocuments()).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0]).toMatchObject({ id: 'evt_1', type: 'payment_intent.succeeded' });
  });

  it('answers 503 until the webhook secret is set', async () => {
    const saved = env.STRIPE_WEBHOOK_SECRET;
    env.STRIPE_WEBHOOK_SECRET = undefined;
    try {
      const response = await deliver(eventPayload());
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    } finally {
      env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});
