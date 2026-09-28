import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { logger } from '../integrations/logger.js';
import { reportError } from '../integrations/sentry.js';
import { jobHandlers, type JobContext, type JobHandlers } from './handlers/index.js';
import { JobModel, type JobDocument, type JobStatus } from './job.model.js';

/** Wait before each retry: 1 min, 5 min, 25 min, then 2 h (plan §4.2). */
const RETRY_DELAYS_MS = [1, 5, 25, 120].map((minutes) => minutes * 60_000);
/** A job still RUNNING after this long belongs to an instance that crashed. */
const STUCK_AFTER_MS = 10 * 60_000;
const RECOVER_EVERY_MS = 60_000;
const MAX_ERROR_LENGTH = 2_000;

type AnyHandler = (payload: unknown, context: JobContext) => Promise<void>;

export interface JobRunnerOptions {
  /** How many jobs this instance runs at once (plan §13.6). */
  concurrency?: number;
  pollIntervalMs?: number;
  handlers?: Partial<JobHandlers>;
  instanceId?: string;
  log?: Logger;
}

export interface JobRunner {
  /** Polls for due jobs until stop() is called. */
  start(): void;
  /**
   * Stops claiming jobs and waits for the running ones. Any still running after `timeoutMs` are put
   * back in the queue for another instance, so a deploy never loses a job (plan §13.4).
   */
  stop(timeoutMs?: number): Promise<void>;
  /** Runs every due job one after another, then resolves. For tests and one-off scripts. */
  drain(): Promise<void>;
  /** Puts jobs left RUNNING by a crashed instance back in the queue. Returns how many it found. */
  recoverStuckJobs(): Promise<number>;
}

/**
 * The job runner inside the backend app (plan §4.2). Every instance polls every 5 s and claims
 * due jobs one at a time with an atomic update, so two instances never run the same job.
 */
export function createJobRunner({
  concurrency = 1,
  pollIntervalMs = 5_000,
  handlers = jobHandlers,
  instanceId = `${hostname()}-${randomUUID().slice(0, 8)}`,
  log = logger.child({ component: 'jobs' }),
}: JobRunnerOptions = {}): JobRunner {
  const running = new Map<string, { job: JobDocument; done: Promise<void> }>();
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;
  // The claiming loop in progress, if any; stop() waits for it so a job claimed at that moment isn't missed.
  let filling: Promise<void> | undefined;
  let lastRecovery = 0;

  const claimNext = () =>
    JobModel.findOneAndUpdate(
      { status: 'QUEUED', runAt: mongoose.trusted({ $lte: new Date() }) },
      { $set: { status: 'RUNNING', lockedAt: new Date(), lockedBy: instanceId }, $inc: { attempts: 1 } },
      { sort: { runAt: 1 }, new: true },
    );

  // Matches only this claim of the job, so a job put back in the queue (or claimed again
  // elsewhere) is never overwritten by a handler that finishes late.
  const thisClaim = (job: JobDocument) => ({
    _id: job._id,
    status: 'RUNNING',
    lockedBy: instanceId,
    lockedAt: job.lockedAt,
  });
  const unlock = { lockedAt: 1, lockedBy: 1 } as const;

  async function finish(job: JobDocument, status: JobStatus, lastError?: string) {
    await JobModel.updateOne(thisClaim(job), {
      $set: { status, finishedAt: new Date(), ...(lastError && { lastError }) },
      $unset: unlock,
    });
  }

  async function execute(job: JobDocument): Promise<void> {
    const jobLog = log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    const handler = (handlers as Record<string, AnyHandler | undefined>)[job.type];
    if (!handler) {
      await finish(job, 'FAILED', `No handler for job type "${job.type}"`);
      jobLog.error('Job failed permanently: no handler for this job type');
      return;
    }

    try {
      await handler(job.payload, { job, log: jobLog });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
      if (job.attempts >= job.maxAttempts) {
        await finish(job, 'FAILED', message);
        // CloudWatch counts this message for the failed-jobs alarm (plan §13.1).
        jobLog.error({ err: error }, 'Job failed permanently');
        reportError(error, {
          tags: { jobType: job.type },
          extra: { jobId: job.id, attempts: job.attempts },
        });
        return;
      }
      const delay = RETRY_DELAYS_MS[Math.min(job.attempts, RETRY_DELAYS_MS.length) - 1]!;
      const retryAt = new Date(Date.now() + delay);
      await JobModel.updateOne(thisClaim(job), {
        $set: { status: 'QUEUED', runAt: retryAt, lastError: message },
        $unset: unlock,
      });
      jobLog.warn({ err: error, retryAt }, 'Job failed; it will be retried');
      return;
    }

    await finish(job, 'DONE');
  }

  function track(job: JobDocument) {
    const done = execute(job)
      .catch((error: unknown) => {
        // Saving the outcome failed; the job stays RUNNING and is recovered after 10 minutes.
        log.error({ err: error, jobId: job.id }, 'Could not save the outcome of a job');
      })
      .finally(() => {
        running.delete(job.id);
        void fill();
      });
    running.set(job.id, { job, done });
  }

  async function claimUntilFull(): Promise<void> {
    try {
      while (!stopping && running.size < concurrency) {
        const job = await claimNext();
        if (!job) break;
        // Claimed just as shutdown began: hand it straight back rather than start it.
        if (stopping) {
          await releaseJob(job);
          break;
        }
        track(job);
      }
    } catch (error) {
      log.error({ err: error }, 'Could not claim a job');
    }
  }

  /** Claims due jobs until every slot is busy or nothing is due. */
  function fill(): Promise<void> {
    if (!filling && !stopping && running.size < concurrency) {
      filling = claimUntilFull().finally(() => {
        filling = undefined;
      });
    }
    return filling ?? Promise.resolve();
  }

  async function recoverStuckJobs(): Promise<number> {
    const now = new Date();
    const stuck = {
      status: 'RUNNING',
      lockedAt: mongoose.trusted({ $lt: new Date(now.getTime() - STUCK_AFTER_MS) }),
    };
    const lastError = 'Its server stopped while the job was running';

    const failed = await JobModel.updateMany(
      { ...stuck, $expr: mongoose.trusted({ $gte: ['$attempts', '$maxAttempts'] }) },
      { $set: { status: 'FAILED', finishedAt: now, lastError }, $unset: unlock },
    );
    const requeued = await JobModel.updateMany(stuck, {
      $set: { status: 'QUEUED', runAt: now, lastError },
      $unset: unlock,
    });

    if (failed.modifiedCount > 0) {
      log.error({ count: failed.modifiedCount }, 'Job failed permanently: stuck while running');
    }
    if (requeued.modifiedCount > 0) {
      log.warn({ count: requeued.modifiedCount }, 'Put stuck jobs back in the queue');
    }
    return failed.modifiedCount + requeued.modifiedCount;
  }

  async function tick() {
    if (Date.now() - lastRecovery >= RECOVER_EVERY_MS) {
      lastRecovery = Date.now();
      await recoverStuckJobs().catch((error: unknown) => {
        log.error({ err: error }, 'Could not recover stuck jobs');
      });
    }
    await fill();
  }

  /** Puts a job this instance claimed back in the queue, for another instance to run. */
  async function releaseJob(job: JobDocument) {
    await JobModel.updateOne(thisClaim(job), {
      $set: { status: 'QUEUED', runAt: new Date() },
      // This run didn't finish, so it doesn't use up one of the job's attempts.
      $inc: { attempts: -1 },
      $unset: unlock,
    });
    log.info({ jobId: job.id, jobType: job.type }, 'Put a job back in the queue for shutdown');
  }

  return {
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(() => void tick(), pollIntervalMs);
      timer.unref();
      void tick();
      log.info({ instanceId, concurrency }, 'Job runner started');
    },

    async stop(timeoutMs = 20_000) {
      stopping = true;
      clearInterval(timer);
      timer = undefined;
      await filling;
      if (running.size === 0) return;

      let timeout: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.all([...running.values()].map(({ done }) => done)).then(() => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(true), timeoutMs);
        }),
      ]);
      clearTimeout(timeout);
      if (timedOut) {
        for (const { job } of running.values()) await releaseJob(job);
      }
    },

    async drain() {
      for (let job = await claimNext(); job; job = await claimNext()) {
        await execute(job);
      }
    },

    recoverStuckJobs,
  };
}
