import Stripe from 'stripe';
import { CHARGE_CURRENCY, isStripeTestMode, stripe } from '../../integrations/stripe.js';
import { HttpError } from '../../lib/http-error.js';
import type { TestPayment, TestPaymentStatus } from './payments.schemas.js';
import { StripeEventModel } from './stripe-event.model.js';

/** NZ$1.00: above Stripe's 50-cent NZD minimum, and a clear amount on the Apple Pay and Google Pay sheets. */
export const TEST_PAYMENT_CENTS = 100;
const PURPOSE = 'stripe_setup_check';

const notFound = () => new HttpError(404, 'NOT_FOUND', 'No test payment with that id.');

/**
 * Starts a NZ$1 payment in the Stripe sandbox, so staff can check the keys, Apple Pay, Google Pay
 * and the webhook before the booking flow exists (plan §8.1, item 17). It uses the same settings as
 * a booking: NZD, with the payment methods turned on in the Stripe Dashboard. Refused with live keys.
 */
export async function createTestPayment(staffId: string): Promise<TestPayment> {
  const client = stripe();
  if (!isStripeTestMode()) {
    throw new HttpError(409, 'LIVE_MODE', 'Test payments only run with Stripe sandbox keys (sk_test_…).');
  }
  const intent = await client.paymentIntents.create({
    amount: TEST_PAYMENT_CENTS,
    currency: CHARGE_CURRENCY,
    automatic_payment_methods: { enabled: true },
    description: 'Rento Vroom test payment',
    metadata: { purpose: PURPOSE, staffId },
  });
  return {
    id: intent.id,
    clientSecret: intent.client_secret!,
    amountCents: intent.amount,
    currency: CHARGE_CURRENCY,
  };
}

/** The test payment's status, how it was paid, and whether its webhook arrived. */
export async function getTestPayment(id: string): Promise<TestPaymentStatus> {
  const client = stripe();
  if (!/^pi_\w+$/.test(id)) throw notFound();

  let intent: Stripe.PaymentIntent;
  try {
    intent = await client.paymentIntents.retrieve(id, { expand: ['latest_charge'] });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) throw notFound();
    throw error;
  }
  if (intent.metadata.purpose !== PURPOSE) throw notFound();

  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const details = charge?.payment_method_details;
  const webhookReceived = await StripeEventModel.exists({
    objectId: intent.id,
    type: 'payment_intent.succeeded',
  });

  return {
    id: intent.id,
    status: intent.status,
    amountCents: intent.amount,
    currency: intent.currency,
    paymentMethod: details
      ? {
          type: details.type,
          wallet: details.card?.wallet?.type ?? null,
          brand: details.card?.brand ?? null,
          last4: details.card?.last4 ?? null,
        }
      : null,
    webhookReceived: Boolean(webhookReceived),
  };
}
