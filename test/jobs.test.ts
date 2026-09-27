import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { EmailJobPayload } from '../src/jobs/handlers/email-send.js';
import type { JobHandlers } from '../src/jobs/handlers/index.js';
import { JobModel } from '../src/jobs/job.model.js';
import { cancelJobs, enqueue } from '../src/jobs/queue.js';
import { createJobRunner, type JobRunnerOptions } from '../src/jobs/runner.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/integrations/mailer/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMailer: () => ({ provider: 'console', send }),
}));

const silentLog = pino({ level: 'silent' });
const welcome: EmailJobPayload = {
  to: 'hana@example.co.nz',
  template: 'welcome',
  props: { firstName: 'Hana', browseUrl: 'https://www.example.co.nz/' },
};
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

function runner(handle: JobHandlers['email.send'], options: JobRunnerOptions = {}) {
  return createJobRunner({ handlers: { 'email.send': handle }, log: silentLog, ...options });
}

describe('job queue', () => {
  it('runs a due job once and marks it done', async () => {
    const handle = vi.fn(async () => {});
    const job = await enqueue('email.send', welcome);

    await runner(handle).drain();

    expect(handle).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledWith(welcome, expect.objectContaining({ job: expect.anything() }));
    const saved = await JobModel.findById(job._id).lean();
    expect(saved).toMatchObject({ status: 'DONE', attempts: 1 });
    expect(saved?.finishedAt).toBeInstanceOf(Date);
    expect(saved?.lockedBy).toBeUndefined();
  });

  it('leaves a job alone until it is due', async () => {
    const handle = vi.fn(async () => {});
    await enqueue('email.send', welcome, { runAt: minutesFromNow(60) });

    await runner(handle).drain();

    expect(handle).not.toHaveBeenCalled();
    expect(await JobModel.countDocuments({ status: 'QUEUED' })).toBe(1);
  });

  it('retries a failing job after a minute, then marks it failed when attempts run out', async () => {
    const handle = vi.fn(async () => {
      throw new Error('Resend is down');
    });
    const job = await enqueue('email.send', welcome, { maxAttempts: 2 });
    const jobs = runner(handle);

    await jobs.drain();
    const retry = await JobModel.findById(job._id).lean();
    expect(retry).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'Resend is down' });
    expect(retry!.runAt.getTime()).toBeGreaterThan(minutesFromNow(0.9).getTime());
    expect(retry!.runAt.getTime()).toBeLessThan(minutesFromNow(1.1).getTime());

    await JobModel.updateOne({ _id: job._id }, { runAt: new Date() });
    await jobs.drain();
    const failed = await JobModel.findById(job._id).lean();
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 2, lastError: 'Resend is down' });
    expect(failed?.finishedAt).toBeInstanceOf(Date);
  });

  it('fails a job whose type has no handler', async () => {
    const job = await JobModel.create({ type: 'unknown.type', runAt: new Date() });

    await runner(async () => {}).drain();

    expect(await JobModel.findById(job._id).lean()).toMatchObject({
      status: 'FAILED',
      lastError: 'No handler for job type "unknown.type"',
    });
  });

  it('creates a job only once for the same uniqueKey', async () => {
    const [first, second] = await Promise.all([
      enqueue('email.send', welcome, { uniqueKey: 'welcome:hana' }),
      enqueue('email.send', welcome, { uniqueKey: 'welcome:hana' }),
    ]);

    expect(first.id).toBe(second.id);
    expect(await JobModel.countDocuments()).toBe(1);
  });

  it('cancels the queued jobs about one record', async () => {
    await enqueue('email.send', welcome, { refId: 'booking-1', runAt: minutesFromNow(60) });
    await enqueue('email.send', welcome, { refId: 'booking-1', runAt: minutesFromNow(120) });
    await enqueue('email.send', welcome, { refId: 'booking-2', runAt: minutesFromNow(60) });

    expect(await cancelJobs('booking-1')).toBe(2);
    expect(await JobModel.countDocuments({ status: 'CANCELLED' })).toBe(2);
    expect(await JobModel.countDocuments({ refId: 'booking-2', status: 'QUEUED' })).toBe(1);
  });

  it('never runs a job on two instances', async () => {
    await Promise.all(Array.from({ length: 12 }, () => enqueue('email.send', welcome)));
    const runs = new Map<string, number>();
    const handle: JobHandlers['email.send'] = async (_payload, { job }) => {
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
    };

    await Promise.all([
      runner(handle, { instanceId: 'task-a' }).drain(),
      runner(handle, { instanceId: 'task-b' }).drain(),
    ]);

    expect(runs.size).toBe(12);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
  });

  it('puts jobs left running by a crashed instance back in the queue', async () => {
    const lockedAt = minutesFromNow(-11);
    const stuck = await JobModel.create({
      type: 'email.send',
      runAt: lockedAt,
      status: 'RUNNING',
      attempts: 1,
      lockedAt,
      lockedBy: 'crashed-task',
    });
    const outOfAttempts = await JobModel.create({
      type: 'email.send',
      runAt: lockedAt,
      status: 'RUNNING',
      attempts: 5,
      lockedAt,
      lockedBy: 'crashed-task',
    });
    const busy = await JobModel.create({
      type: 'email.send',
      runAt: new Date(),
      status: 'RUNNING',
      attempts: 1,
      lockedAt: new Date(),
      lockedBy: 'healthy-task',
    });

    expect(await runner(async () => {}).recoverStuckJobs()).toBe(2);

    expect(await JobModel.findById(stuck._id).lean()).toMatchObject({ status: 'QUEUED' });
    expect(await JobModel.findById(outOfAttempts._id).lean()).toMatchObject({ status: 'FAILED' });
    expect(await JobModel.findById(busy._id).lean()).toMatchObject({ status: 'RUNNING' });
  });

  it('runs jobs as they become due, and hands back an unfinished one when stopped', async () => {
    let finishSlowJob: () => void = () => {};
    const handle = vi.fn(async (payload: EmailJobPayload) => {
      if (payload.to === 'slow@example.co.nz') {
        await new Promise<void>((resolve) => {
          finishSlowJob = resolve;
        });
      }
    });
    const jobs = runner(handle, { pollIntervalMs: 20 });
    jobs.start();

    const quick = await enqueue('email.send', welcome);
    await vi.waitFor(async () => expect((await JobModel.findById(quick._id))?.status).toBe('DONE'));

    const slow = await enqueue('email.send', { ...welcome, to: 'slow@example.co.nz' });
    await vi.waitFor(async () => expect((await JobModel.findById(slow._id))?.status).toBe('RUNNING'));

    await jobs.stop(50);
    const handedBack = await JobModel.findById(slow._id).lean();
    expect(handedBack).toMatchObject({ status: 'QUEUED', attempts: 0 });

    // The handler finishing late doesn't overwrite the job another instance may now be running.
    finishSlowJob();
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await JobModel.findById(slow._id).lean())?.status).toBe('QUEUED');
  });

  it('sends queued email through the real email.send handler', async () => {
    send.mockResolvedValue({ id: 'email_1', provider: 'console' });
    await enqueue('email.send', welcome);

    await createJobRunner({ log: silentLog }).drain();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'hana@example.co.nz', subject: 'Welcome to Rento Vroom, Hana' }),
    );
    expect(await JobModel.countDocuments({ status: 'DONE' })).toBe(1);
  });
});
