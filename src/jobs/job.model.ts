import { Schema, model, type HydratedDocument } from 'mongoose';

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** A background job in the MongoDB queue (plan §3 `jobs`, §4.2). */
export interface Job {
  type: string;
  payload: unknown;
  runAt: Date;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  uniqueKey?: string;
  refId?: string;
  lockedAt?: Date;
  lockedBy?: string;
  lastError?: string;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<Job>(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    runAt: { type: Date, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'QUEUED' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    uniqueKey: String,
    refId: { type: String, index: true },
    lockedAt: Date,
    lockedBy: String,
    lastError: String,
    // TTL index: finished jobs are deleted 30 days after they finish.
    finishedAt: { type: Date, expires: 30 * 24 * 60 * 60 },
  },
  { timestamps: true, minimize: false },
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index(
  { uniqueKey: 1 },
  { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' } } },
);

export const JobModel = model<Job>('Job', jobSchema);
export type JobDocument = HydratedDocument<Job>;
