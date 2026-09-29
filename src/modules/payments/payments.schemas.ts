import { z } from 'zod';

/** A NZ$1 sandbox payment started from the staff portal, ready for Stripe.js to confirm. */
export const testPaymentSchema = z
  .object({
    id: z.string().meta({ description: 'The Stripe PaymentIntent id (pi_…)' }),
    clientSecret: z
      .string()
      .meta({ description: 'Lets Stripe.js on the page confirm this one payment. Never logged or stored.' }),
    amountCents: z.number().int(),
    currency: z.literal('nzd'),
  })
  .meta({ id: 'TestPayment' });

/** How a test payment went, and whether its webhook reached the API. */
export const testPaymentStatusSchema = z
  .object({
    id: z.string(),
    status: z.string().meta({
      description:
        'The PaymentIntent status: succeeded, processing, requires_payment_method, requires_action, canceled, …',
    }),
    amountCents: z.number().int(),
    currency: z.string(),
    paymentMethod: z
      .object({
        type: z.string().meta({ description: 'The payment method type, e.g. card or link' }),
        wallet: z
          .string()
          .nullable()
          .meta({ description: 'apple_pay or google_pay when a card was paid through a wallet' }),
        brand: z.string().nullable().meta({ description: 'The card brand, e.g. visa' }),
        last4: z.string().nullable(),
      })
      .nullable()
      .meta({ description: 'Null until the payment has been attempted' }),
    webhookReceived: z
      .boolean()
      .meta({ description: 'Whether Stripe’s payment_intent.succeeded event reached the webhook' }),
  })
  .meta({ id: 'TestPaymentStatus' });

export type TestPayment = z.infer<typeof testPaymentSchema>;
export type TestPaymentStatus = z.infer<typeof testPaymentStatusSchema>;
