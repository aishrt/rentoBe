import Stripe from 'stripe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import { testPaymentSchema, testPaymentStatusSchema } from '../src/modules/payments/payments.schemas.js';
import { StripeEventModel } from '../src/modules/payments/stripe-event.model.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

const client = stripe();

function intent(overrides: Partial<Stripe.PaymentIntent> = {}) {
  return {
    id: 'pi_123',
    object: 'payment_intent',
    client_secret: 'pi_123_secret_abc',
    amount: 100,
    currency: 'nzd',
    status: 'requires_payment_method',
    metadata: { purpose: 'stripe_setup_check' },
    latest_charge: null,
    ...overrides,
  } as unknown as Stripe.Response<Stripe.PaymentIntent>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Admin test payment', () => {
  it('starts a NZ$1 payment with the payment methods set in the Dashboard', async () => {
    const create = vi.spyOn(client.paymentIntents, 'create').mockResolvedValue(intent());
    const admin = await createStaff();
    const agent = await staffAgent();

    const response = await agent.post('/api/v1/admin/payments/test');

    expect(response.status).toBe(201);
    expect(testPaymentSchema.parse(response.body)).toEqual({
      id: 'pi_123',
      clientSecret: 'pi_123_secret_abc',
      amountCents: 100,
      currency: 'nzd',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 100,
        currency: 'nzd',
        automatic_payment_methods: { enabled: true },
        metadata: { purpose: 'stripe_setup_check', staffId: admin.id },
      }),
    );
  });

  it('is for admins only', async () => {
    const create = vi.spyOn(client.paymentIntents, 'create');
    await createStaff('mere@example.co.nz', 'SUPPORT');
    const support = await staffAgent('mere@example.co.nz');
    expect((await support.post('/api/v1/admin/payments/test')).status).toBe(403);

    await createUser();
    const guest = browserAgent();
    await guest.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });
    expect((await guest.post('/api/v1/admin/payments/test')).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('is refused with live keys, and unavailable without keys', async () => {
    const create = vi.spyOn(client.paymentIntents, 'create');
    await createStaff();
    const agent = await staffAgent();
    const saved = env.STRIPE_SECRET_KEY;
    try {
      env.STRIPE_SECRET_KEY = 'sk_live_fake';
      const live = await agent.post('/api/v1/admin/payments/test');
      expect(live.status).toBe(409);
      expect(live.body.error.code).toBe('LIVE_MODE');

      env.STRIPE_SECRET_KEY = undefined;
      const unset = await agent.post('/api/v1/admin/payments/test');
      expect(unset.status).toBe(503);
      expect(unset.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    } finally {
      env.STRIPE_SECRET_KEY = saved;
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('reports how it was paid and whether the webhook arrived', async () => {
    const paid = intent({
      status: 'succeeded',
      latest_charge: {
        id: 'ch_1',
        payment_method_details: {
          type: 'card',
          card: { brand: 'visa', last4: '4242', wallet: { type: 'apple_pay' } },
        },
      } as unknown as Stripe.Charge,
    });
    const retrieve = vi.spyOn(client.paymentIntents, 'retrieve').mockResolvedValue(paid);
    await createStaff();
    const agent = await staffAgent();

    const before = await agent.get('/api/v1/admin/payments/test/pi_123');
    expect(before.status).toBe(200);
    expect(testPaymentStatusSchema.parse(before.body)).toEqual({
      id: 'pi_123',
      status: 'succeeded',
      amountCents: 100,
      currency: 'nzd',
      paymentMethod: { type: 'card', wallet: 'apple_pay', brand: 'visa', last4: '4242' },
      webhookReceived: false,
    });
    expect(retrieve).toHaveBeenCalledWith('pi_123', { expand: ['latest_charge'] });

    await StripeEventModel.create({ eventId: 'evt_1', type: 'payment_intent.succeeded', objectId: 'pi_123' });
    expect((await agent.get('/api/v1/admin/payments/test/pi_123')).body.webhookReceived).toBe(true);
  });

  it("won't show other payments or ids Stripe doesn't know", async () => {
    const retrieve = vi
      .spyOn(client.paymentIntents, 'retrieve')
      .mockResolvedValueOnce(intent({ metadata: { bookingId: 'b1' } }))
      .mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          message: 'No such payment_intent',
        }),
      );
    await createStaff();
    const agent = await staffAgent();

    expect((await agent.get('/api/v1/admin/payments/test/pi_123')).status).toBe(404);
    expect((await agent.get('/api/v1/admin/payments/test/pi_missing')).status).toBe(404);
    expect((await agent.get('/api/v1/admin/payments/test/not-an-id')).status).toBe(404);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
