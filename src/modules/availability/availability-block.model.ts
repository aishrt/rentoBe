import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const BLOCK_REASONS = ['BOOKED', 'HOLD', 'HOST_BLOCK', 'RECURRING', 'BUFFER', 'ADMIN'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * A time range a car can't be booked (plan §3 `availabilityBlocks`). Only the availability service writes
 * these, inside a transaction, so two bookings can never overlap.
 */
export interface AvailabilityBlock {
  vehicleId: Types.ObjectId;
  startAt: Date;
  endAt: Date;
  reason: BlockReason;
  bookingId?: Types.ObjectId;
  /** HOLD only: dates held during checkout, or while a request waits for the Host (plan §8.2). */
  expiresAt?: Date;
  /** HOST_BLOCK and ADMIN: the Host's or staff member's note, e.g. "Servicing". */
  note?: string;
  /** HOST_BLOCK and ADMIN: who added it. */
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const availabilityBlockSchema = new Schema<AvailabilityBlock>(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    startAt: { type: Date, required: true },
    endAt: {
      type: Date,
      required: true,
      validate: {
        validator(this: AvailabilityBlock, endAt: Date) {
          return !this.startAt || endAt > this.startAt;
        },
        message: 'endAt must be after startAt',
      },
    },
    reason: { type: String, enum: BLOCK_REASONS, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    expiresAt: Date,
    note: { type: String, trim: true, maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'availabilityBlocks', timestamps: true },
);

// The overlap check: startAt < requested end and endAt > requested start.
availabilityBlockSchema.index({ vehicleId: 1, startAt: 1, endAt: 1 });
// A booking's blocks are released together when it's cancelled or expires.
availabilityBlockSchema.index(
  { bookingId: 1 },
  { partialFilterExpression: { bookingId: { $type: 'objectId' } } },
);

export const AvailabilityBlockModel = model<AvailabilityBlock>('AvailabilityBlock', availabilityBlockSchema);
export type AvailabilityBlockDocument = HydratedDocument<AvailabilityBlock>;
