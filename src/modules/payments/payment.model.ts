import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { cents } from '../../lib/model-fields.js';

export const PAYMENT_TYPES = ['BOOKING', 'EXTRA_CHARGE'] as const;

export const PAYMENT_STATUSES = [
  'PENDING',
  'AUTHORISED',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  /** An authorisation released, or a payment abandoned: nothing was charged. */
  'CANCELLED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Who pays for a refund: the platform (goodwill, its own fees) or the Host (plan §8.1, item 15). */
export const REFUND_FUNDERS = ['PLATFORM', 'HOST'] as const;

export interface Refund {
  _id?: Types.ObjectId;
  amountCents: number;
  reason: string;
  issuedBy?: Types.ObjectId;
  fundedBy: (typeof REFUND_FUNDERS)[number];
  stripeRefundId?: string;
  /** A failed refund alerts support (plan §8.1, item 21). */
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  failureReason?: string;
  createdAt: Date;
}

/** A card chargeback (plan §8.1, item 12). */
export interface Dispute {
  stripeDisputeId: string;
  reason?: string;
  status: string;
  dueBy?: Date;
}

/** The `payments` collection (plan §3): one Stripe PaymentIntent. */
export interface Payment {
  bookingId: Types.ObjectId;
  type: (typeof PAYMENT_TYPES)[number];
  stripePaymentIntentId: string;
  amountCents: number;
  status: PaymentStatus;
  method?: string;
  failureReason?: string;
  refunds: Refund[];
  dispute?: Dispute;
  createdAt: Date;
  updatedAt: Date;
}

const refundSchema = new Schema<Refund>({
  amountCents: { ...cents({ required: true }), min: 1 },
  reason: { type: String, required: true },
  issuedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  fundedBy: { type: String, enum: REFUND_FUNDERS, required: true },
  stripeRefundId: String,
  status: { type: String, enum: ['PENDING', 'SUCCEEDED', 'FAILED'], default: 'PENDING' },
  failureReason: String,
  createdAt: { type: Date, default: Date.now },
});

const paymentSchema = new Schema<Payment>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    type: { type: String, enum: PAYMENT_TYPES, required: true },
    stripePaymentIntentId: { type: String, required: true },
    amountCents: cents({ required: true }),
    status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING' },
    method: String,
    failureReason: String,
    refunds: { type: [refundSchema], default: [] },
    dispute: {
      type: new Schema<Dispute>(
        {
          stripeDisputeId: { type: String, required: true },
          reason: String,
          status: { type: String, required: true },
          dueBy: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

paymentSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ status: 1, createdAt: -1 });

export const PaymentModel = model<Payment>('Payment', paymentSchema);
export type PaymentDocument = HydratedDocument<Payment>;
