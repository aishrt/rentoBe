import { Schema, model } from 'mongoose';

/** Stripe webhook events already handled, so a repeated event is skipped (plan §8.1, item 13). */
export interface StripeEvent {
  eventId: string;
  type: string;
  processedAt: Date;
}

const stripeEventSchema = new Schema<StripeEvent>(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    processedAt: { type: Date, required: true, default: Date.now },
  },
  { collection: 'stripeEvents' },
);

stripeEventSchema.index({ eventId: 1 }, { unique: true });

export const StripeEventModel = model<StripeEvent>('StripeEvent', stripeEventSchema);
