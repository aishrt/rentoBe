import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { stars } from '../../lib/model-fields.js';

export const REVIEW_DIRECTIONS = ['GUEST_TO_HOST', 'HOST_TO_GUEST'] as const;
export type ReviewDirection = (typeof REVIEW_DIRECTIONS)[number];

/** AWAITING_REVEAL until both sides have reviewed or the review window closes (plan §9, Days 21–22). */
export const REVIEW_STATUSES = ['AWAITING_REVEAL', 'PUBLISHED', 'HIDDEN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const MODERATION_STATES = ['CLEAR', 'HELD', 'HIDDEN'] as const;

export interface ReviewModeration {
  state: (typeof MODERATION_STATES)[number];
  reason?: string;
  by?: Types.ObjectId;
  at?: Date;
}

/**
 * The `reviews` collection (plan §3). Guest → Host reviews carry the vehicleId: they show on the listing
 * and count in the car's rating. The categories differ by direction: cleanliness is for the car, care is
 * for the Guest.
 */
export interface Review {
  bookingId: Types.ObjectId;
  vehicleId?: Types.ObjectId;
  authorId: Types.ObjectId;
  subjectId: Types.ObjectId;
  direction: ReviewDirection;
  overall: number;
  communication?: number;
  pickupReturn?: number;
  cleanliness?: number;
  care?: number;
  body?: string;
  status: ReviewStatus;
  revealAt?: Date;
  moderation: ReviewModeration;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<Review>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    subjectId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    direction: { type: String, enum: REVIEW_DIRECTIONS, required: true },
    overall: stars({ required: true }),
    communication: stars(),
    pickupReturn: stars(),
    cleanliness: stars(),
    care: stars(),
    body: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: REVIEW_STATUSES, default: 'AWAITING_REVEAL' },
    revealAt: Date,
    moderation: {
      type: new Schema<ReviewModeration>(
        {
          state: { type: String, enum: MODERATION_STATES, default: 'CLEAR' },
          reason: String,
          by: { type: Schema.Types.ObjectId, ref: 'User' },
          at: Date,
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { timestamps: true },
);

// One review each way per trip.
reviewSchema.index({ bookingId: 1, direction: 1 }, { unique: true });
reviewSchema.index({ subjectId: 1, status: 1, createdAt: -1 });
// Listing reviews.
reviewSchema.index({ vehicleId: 1, status: 1, createdAt: -1 });

export const ReviewModel = model<Review>('Review', reviewSchema);
export type ReviewDocument = HydratedDocument<Review>;
