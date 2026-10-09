import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const REPORT_TARGET_TYPES = ['USER', 'MESSAGE', 'REVIEW', 'VEHICLE'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
export const REPORT_STATUSES = ['OPEN', 'ACTIONED', 'DISMISSED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** Why something is reported, for the moderation queue. */
export const REPORT_REASONS = [
  'SPAM',
  'SCAM',
  'HARASSMENT',
  'INAPPROPRIATE',
  'CONTACT_DETAILS',
  'FAKE',
  'SAFETY',
  'OTHER',
] as const;

/** A user's report of another user, a message, a review or a listing (plan §3 `reports`). */
export interface Report {
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  /** The person the report is about: the user, the message's sender, the review's author or the car's Host. */
  subjectUserId?: Types.ObjectId;
  /**
   * A member reported from a booking's conversation: that booking, so support can open its thread from the
   * report (plan §6.2). Reported messages find theirs through the message.
   */
  bookingId?: Types.ObjectId;
  reason: string;
  note?: string;
  status: ReportStatus;
  handledBy?: Types.ObjectId;
  handledAt?: Date;
  /** What support did, for the record. */
  resolution?: string;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<Report>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: REPORT_TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    subjectUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    reason: { type: String, required: true },
    note: { type: String, maxlength: 2000 },
    status: { type: String, enum: REPORT_STATUSES, default: 'OPEN' },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    handledAt: Date,
    resolution: { type: String, maxlength: 2000 },
  },
  { timestamps: true },
);

// The moderation queue, newest first.
reportSchema.index({ status: 1, createdAt: -1 });
// Repeated reports about one person raise a risk flag (plan §14).
reportSchema.index({ subjectUserId: 1, createdAt: -1 });

export const ReportModel = model<Report>('Report', reportSchema);
export type ReportDocument = HydratedDocument<Report>;
