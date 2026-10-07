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

/** A card saved to the Guest's Stripe customer, for checkout and post-trip charges (plan §8.1, item 7). */
export const savedCardSchema = z
  .object({
    id: z.string().meta({ description: 'The Stripe PaymentMethod id (pm_…)' }),
    brand: z.string().meta({ description: 'e.g. visa, mastercard, amex' }),
    last4: z.string(),
    expMonth: z.number().int(),
    expYear: z.number().int(),
    expired: z.boolean(),
    wallet: z
      .enum(['apple_pay', 'google_pay'])
      .optional()
      .meta({ description: 'Saved from Apple Pay or Google Pay' }),
  })
  .meta({ id: 'SavedCard' });
export type SavedCard = z.infer<typeof savedCardSchema>;

export const savedCardsResponseSchema = z
  .object({ cards: z.array(savedCardSchema) })
  .meta({ id: 'SavedCards' });

export const cardSetupResponseSchema = z
  .object({
    clientSecret: z
      .string()
      .meta({ description: 'For the Payment Element to save one card. Never logged or stored.' }),
  })
  .meta({ id: 'CardSetup' });

const historyRefundSchema = z.object({
  amountCents: z.number().int(),
  status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']),
  at: z.iso.datetime(),
});

export const paymentHistoryItemSchema = z
  .object({
    id: z.string(),
    bookingRef: z.string(),
    vehicleTitle: z.string(),
    type: z.enum(['BOOKING', 'EXTRA_CHARGE']),
    amountCents: z.number().int(),
    status: z.enum(['AUTHORISED', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']).meta({
      description:
        'AUTHORISED: held on the card, not charged yet. FAILED is only listed for an extra charge still to pay',
    }),
    method: z.string().optional().meta({ description: 'e.g. "Visa ending 4242"' }),
    at: z.iso.datetime(),
    refundedCents: z.number().int(),
    refunds: z.array(historyRefundSchema),
    hasReceipt: z.boolean().meta({ description: 'GET /bookings/{id}/receipt has a receipt for it' }),
  })
  .meta({ id: 'PaymentHistoryItem' });
export type PaymentHistoryItem = z.infer<typeof paymentHistoryItemSchema>;

export const paymentHistoryResponseSchema = z
  .object({ payments: z.array(paymentHistoryItemSchema).meta({ description: 'Newest first, up to 100' }) })
  .meta({ id: 'PaymentHistory' });
