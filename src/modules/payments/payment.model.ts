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

/**
 * Why a refund was made, for reports: a cancellation's own refund, the return of a payment that arrived after
 * its booking ended, or one staff issued. Refunds recorded before this field existed have none.
 */
export const REFUND_KINDS = ['CANCELLATION', 'LATE_PAYMENT', 'STAFF'] as const;

export interface Refund {
  _id?: Types.ObjectId;
  amountCents: number;
  reason: string;
  kind?: (typeof REFUND_KINDS)[number];
  issuedBy?: Types.ObjectId;
  fundedBy: (typeof REFUND_FUNDERS)[number];
  /**
   * HOST: the Host's share of it, what they pay back (plan §8.1, item 15); the platform covers its
   * commission. Refunds recorded before this field existed have none: the Host paid all of it.
   */
  hostCents?: number;
  /**
   * HOST, made before the booking was cancelled: what the cancellation took off the Host's share of it, as the
   * Guest got that part back under the cancellation anyway (plan §8.1, item 15). `hostCents` is what's left.
   */
  hostReliefCents?: number;
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

/**
 * A dispute that's settled (plan §8.1, item 12): won, lost, an inquiry closed with a warning only, or prevented
 * (a dispute prevention programme refunded the cardholder, so the money went back as if it were lost).
 */
export const CLOSED_DISPUTE_STATUSES = ['won', 'lost', 'warning_closed', 'prevented'] as const;

/**
 * A chargeback: the cardholder's bank is deciding it, or the money went back to them through it (plan §8.1,
 * item 12). Stripe refuses a refund of a charge in one, so the dispute decides the money. An inquiry
 * (`warning_*`) isn't a chargeback yet, and can still be refunded.
 */
export const CHARGED_BACK_DISPUTE_STATUSES = ['needs_response', 'under_review', 'lost', 'prevented'] as const;

/** Whether a payment's card dispute is a chargeback (CHARGED_BACK_DISPUTE_STATUSES). */
export const isChargedBack = (payment: { dispute?: Pick<Dispute, 'status'> } | null | undefined) =>
  (CHARGED_BACK_DISPUTE_STATUSES as readonly string[]).includes(payment?.dispute?.status ?? '');

/** The `payments` collection (plan §3): one Stripe PaymentIntent. */
export interface Payment {
  bookingId: Types.ObjectId;
  type: (typeof PAYMENT_TYPES)[number];
  /** EXTRA_CHARGE: which of the booking's extra charges it pays. */
  extraChargeId?: Types.ObjectId;
  stripePaymentIntentId: string;
  amountCents: number;
  status: PaymentStatus;
  method?: string;
  failureReason?: string;
  /**
   * When the money was taken: set as the payment is first recorded as paid, so a refund later (which moves
   * updatedAt) doesn't change it. Payments recorded before this field existed have none.
   */
  succeededAt?: Date;
  refunds: Refund[];
  dispute?: Dispute;
  createdAt: Date;
  updatedAt: Date;
}

const refundSchema = new Schema<Refund>({
  amountCents: { ...cents({ required: true }), min: 1 },
  reason: { type: String, required: true },
  kind: { type: String, enum: REFUND_KINDS },
  issuedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  fundedBy: { type: String, enum: REFUND_FUNDERS, required: true },
  hostCents: cents(),
  hostReliefCents: cents(),
  stripeRefundId: String,
  status: { type: String, enum: ['PENDING', 'SUCCEEDED', 'FAILED'], default: 'PENDING' },
  failureReason: String,
  createdAt: { type: Date, default: Date.now },
});

const paymentSchema = new Schema<Payment>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    type: { type: String, enum: PAYMENT_TYPES, required: true },
    extraChargeId: Schema.Types.ObjectId,
    stripePaymentIntentId: { type: String, required: true },
    amountCents: cents({ required: true }),
    status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING' },
    method: String,
    failureReason: String,
    succeededAt: Date,
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

const PAID: readonly PaymentStatus[] = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

// Every change of status is saved through the document, so the moment it's first paid is caught here.
paymentSchema.pre('save', function stampSucceededAt() {
  if (!this.succeededAt && PAID.includes(this.status) && (this.isNew || this.isModified('status'))) {
    this.succeededAt = new Date();
  }
});

paymentSchema.index({ stripePaymentIntentId: 1 }, { unique: true });
paymentSchema.index({ bookingId: 1 });
paymentSchema.index({ status: 1, createdAt: -1 });

export const PaymentModel = model<Payment>('Payment', paymentSchema);
export type PaymentDocument = HydratedDocument<Payment>;
