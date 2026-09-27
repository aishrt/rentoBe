import mongoose from 'mongoose';
import type { JobPayload, JobType } from './handlers/index.js';
import { JobModel, type JobDocument } from './job.model.js';

export interface EnqueueOptions {
  /** When the job becomes due. Defaults to now. */
  runAt?: Date;
  /** At most one job ever exists with this key, e.g. `expire-request:<bookingId>`, so enqueueing twice is safe. */
  uniqueKey?: string;
  /** The record the job is about, e.g. a booking id, so cancelJobs() can find it. */
  refId?: string;
  maxAttempts?: number;
}

/**
 * Adds a job to the queue (plan §4.2). With a `uniqueKey`, a job that already exists under that
 * key is returned instead of adding a second one.
 */
export async function enqueue<Type extends JobType>(
  type: Type,
  payload: JobPayload<Type>,
  { runAt = new Date(), uniqueKey, refId, maxAttempts }: EnqueueOptions = {},
): Promise<JobDocument> {
  const job = { type, payload, runAt, refId, ...(maxAttempts && { maxAttempts }) };
  if (!uniqueKey) return JobModel.create(job);

  try {
    const saved = await JobModel.findOneAndUpdate(
      { uniqueKey },
      { $setOnInsert: job },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (saved) return saved;
  } catch (error) {
    // Two instances enqueued the same key at the same moment; the unique index kept the first.
    if (!(error instanceof mongoose.mongo.MongoServerError && error.code === 11000)) throw error;
  }
  const existing = await JobModel.findOne({ uniqueKey });
  if (!existing) throw new Error(`Job ${uniqueKey} was not saved`);
  return existing;
}

/**
 * Cancels the queued jobs about one record, e.g. a cancelled booking's reminders (plan §4.2).
 * Jobs already running finish normally. Returns how many were cancelled.
 */
export async function cancelJobs(refId: string, types?: JobType[]): Promise<number> {
  const result = await JobModel.updateMany(
    { refId, status: 'QUEUED', ...(types && { type: mongoose.trusted({ $in: types }) }) },
    { $set: { status: 'CANCELLED', finishedAt: new Date() } },
  );
  return result.modifiedCount;
}
