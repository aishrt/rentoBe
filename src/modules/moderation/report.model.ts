import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const REPORT_TARGET_TYPES = ['USER', 'MESSAGE', 'REVIEW', 'VEHICLE'] as const;
export const REPORT_STATUSES = ['OPEN', 'ACTIONED', 'DISMISSED'] as const;

/** A user's report of another user, a message, a review or a listing (plan §3 `reports`). */
export interface Report {
  reporterId: Types.ObjectId;
  targetType: (typeof REPORT_TARGET_TYPES)[number];
  targetId: Types.ObjectId;
  reason: string;
  note?: string;
  status: (typeof REPORT_STATUSES)[number];
  handledBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<Report>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: REPORT_TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, required: true },
    note: { type: String, maxlength: 2000 },
    status: { type: String, enum: REPORT_STATUSES, default: 'OPEN' },
    handledBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// The moderation queue, newest first.
reportSchema.index({ status: 1, createdAt: -1 });

export const ReportModel = model<Report>('Report', reportSchema);
export type ReportDocument = HydratedDocument<Report>;
