import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { cents } from '../../lib/model-fields.js';

/**
 * A booking has one TRIP or CANCELLATION_FEE payout, then one EXTRA_CHARGE payout for each extra
 * charge that succeeds (plan §3).
 */
export const PAYOUT_TYPES = ['TRIP', 'CANCELLATION_FEE', 'EXTRA_CHARGE'] as const;
/** CANCELLED: the booking was cancelled before its trip payout was sent. */
export const PAYOUT_STATUSES = ['SCHEDULED', 'HELD', 'PAID', 'FAILED', 'CANCELLED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_HOLD_REASONS = [
  'INCIDENT',
  'DISPUTE',
  'PAYOUT_SETUP',
  'TRIP_NOT_STARTED',
  'SUSPENDED',
  /** Held by staff, e.g. while they look into something with the Host. */
  'MANUAL',
] as const;
export type PayoutHoldReason = (typeof PAYOUT_HOLD_REASONS)[number];

export const DEDUCTION_TYPES = ['HOST_CANCELLATION_FEE', 'HOST_FUNDED_REFUND', 'OTHER'] as const;

/** Money taken off a payout, shown as its own line (plan §8.1, items 10 and 15). */
export interface Deduction {
  type: (typeof DEDUCTION_TYPES)[number];
  bookingId?: Types.ObjectId;
  amountCents: number;
}

/** The `payouts` collection (plan §3): money moved to a Host through Stripe Connect. */
export interface Payout {
  hostId: Types.ObjectId;
  bookingId: Types.ObjectId;
  type: (typeof PAYOUT_TYPES)[number];
  extraChargeId?: Types.ObjectId;
  /** What's transferred: the gross less commission and deductions, never below zero. */
  amountCents: number;
  /** What the Guest paid for the Host's part: rental and delivery, the kept fee or the extra charge. */
  grossCents?: number;
  /** The platform's commission on it, with its GST, for GST-registered Hosts' statements (plan §8.1, item 22). */
  commissionCents?: number;
  commissionGstCents?: number;
  stripeTransferId?: string;
  status: PayoutStatus;
  failureReason?: string;
  /** Transfers Stripe refused so far: each try after a refusal uses a new idempotency key. */
  transferAttempts?: number;
  holdReason?: (typeof PAYOUT_HOLD_REASONS)[number];
  scheduledFor: Date;
  paidAt?: Date;
  deductions: Deduction[];
  createdAt: Date;
  updatedAt: Date;
}

const deductionSchema = new Schema<Deduction>(
  {
    type: { type: String, enum: DEDUCTION_TYPES, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    amountCents: cents({ required: true }),
  },
  { _id: false },
);

const payoutSchema = new Schema<Payout>(
  {
    hostId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    type: { type: String, enum: PAYOUT_TYPES, required: true },
    extraChargeId: Schema.Types.ObjectId,
    // Never below zero: anything left over is carried to the next payout as fees owed (plan §3).
    amountCents: cents({ required: true }),
    grossCents: cents(),
    commissionCents: cents(),
    commissionGstCents: cents(),
    stripeTransferId: String,
    status: { type: String, enum: PAYOUT_STATUSES, default: 'SCHEDULED' },
    failureReason: String,
    transferAttempts: Number,
    holdReason: { type: String, enum: PAYOUT_HOLD_REASONS },
    scheduledFor: { type: Date, required: true },
    paidAt: Date,
    deductions: { type: [deductionSchema], default: [] },
  },
  { timestamps: true },
);

payoutSchema.index({ hostId: 1, status: 1, scheduledFor: -1 });
// One payout per booking, type and extra charge, so a retried job can't pay twice (plan §4.2).
payoutSchema.index({ bookingId: 1, type: 1, extraChargeId: 1 }, { unique: true });

export const PayoutModel = model<Payout>('Payout', payoutSchema);
export type PayoutDocument = HydratedDocument<Payout>;
