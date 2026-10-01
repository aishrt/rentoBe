import mongoose, { type ClientSession } from 'mongoose';
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
  /**
   * Adds the job inside this transaction, so it exists only if the change that queued it commits
   * (e.g. a booking confirmed by a webhook, plan §8.1).
   */
  session?: ClientSession;
}

/**
 * Adds a job to the queue (plan §4.2). With a `uniqueKey`, a job that already exists under that
 * key is returned instead of adding a second one.
 */
export async function enqueue<Type extends JobType>(
  type: Type,
  payload: JobPayload<Type>,
  { runAt = new Date(), uniqueKey, refId, maxAttempts, session }: EnqueueOptions = {},
): Promise<JobDocument> {
  const job = { type, payload, runAt, refId, ...(maxAttempts && { maxAttempts }) };
  if (!uniqueKey) {
    const [created] = await JobModel.create([job], { session });
    return created!;
  }

  try {
    const saved = await JobModel.findOneAndUpdate(
      { uniqueKey },
      { $setOnInsert: job },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );
    if (saved) return saved;
  } catch (error) {
    // Two instances enqueued the same key at the same moment; the unique index kept the first.
    if (!(error instanceof mongoose.mongo.MongoServerError && error.code === 11000) || session) throw error;
  }
  const existing = await JobModel.findOne({ uniqueKey }).session(session ?? null);
  if (!existing) throw new Error(`Job ${uniqueKey} was not saved`);
  return existing;
}

/**
 * Cancels the queued jobs about one record, e.g. a cancelled booking's reminders (plan §4.2).
 * Jobs already running finish normally. Returns how many were cancelled.
 */
export async function cancelJobs(refId: string, types?: JobType[], session?: ClientSession): Promise<number> {
  const result = await JobModel.updateMany(
    { refId, status: 'QUEUED', ...(types && { type: mongoose.trusted({ $in: types }) }) },
    { $set: { status: 'CANCELLED', finishedAt: new Date() } },
    { session },
  );
  return result.modifiedCount;
}
