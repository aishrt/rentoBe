import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMailer } from '../src/integrations/mailer/index.js';
import { createResendMailer } from '../src/integrations/mailer/resend-mailer.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { unreadMessageEmailJob } from '../src/jobs/handlers/message-jobs.js';
import { sendNotificationJob } from '../src/jobs/handlers/notification-send.js';
import { JobModel, type JobDocument } from '../src/jobs/job.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import {
  UNREAD_NOTICE_COOLDOWN_MS,
  openThreadForStaff,
  readThread,
  sendMessage,
} from '../src/modules/messages/messages.service.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { createStaff, createUser } from './helpers.js';

/* Unread-message notices (plan §4.3 `messages.unreadEmail`, §7) and support opening a conversation (§6.2). */

const HOUR_MS = 60 * 60 * 1000;
const context = {
  job: { attempts: 1, maxAttempts: 5 } as JobDocument,
  log: { info: vi.fn(), warn: vi.fn() },
} as unknown as JobContext;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A confirmed booking; the Host has a verified mobile and asked for texts about unread messages. */
async function trip() {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  await UserModel.updateOne(
    { _id: host._id },
    {
      $set: {
        phone: '+64211112222',
        phoneVerifiedAt: new Date(),
        'notificationPrefs.unreadMessageSms': true,
      },
    },
  );
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord({ guestId: guest._id, hostId: host._id, vehicleId: vehicle._id });
  const asGuest = { userId: guest.id as string, roles: ['GUEST' as const] };
  const asHost = { userId: host.id as string, roles: ['GUEST' as const, 'HOST' as const] };
  const send = (body: string) => sendMessage(asGuest, booking.ref, { body, attachments: [] });
  return { host, guest, booking, asHost, send };
}

const unreadJobs = () => JobModel.find({ type: 'messages.unreadEmail' }).sort({ createdAt: 1 });
const runJob = (job: JobDocument) =>
  unreadMessageEmailJob(job.payload as { threadId: string; recipientId: string }, context);
const bellNotices = (userId: unknown) =>
  NotificationModel.find({ userId, type: 'NEW_MESSAGE', channel: 'IN_APP' }).sort({ createdAt: 1 });

/** Moves the Host's last notice back in time, as if it went out that long ago. */
async function noticeWentOut(booking: { _id: unknown }, ago: number) {
  await ThreadModel.updateOne(
    { bookingId: booking._id },
    { $set: { 'unreadNotices.0.at': new Date(Date.now() - ago) } },
  );
}

describe('unread-message notices', () => {
  it('sends one notice for a burst of messages', async () => {
    const { host, send } = await trip();
    await send('First');
    await send('Second');
    const [job] = await unreadJobs();
    await runJob(job!);
    expect((await bellNotices(host._id)).map((notice) => notice.payload)).toEqual([
      expect.objectContaining({ title: '2 new messages from Kiri', body: 'Second' }),
    ]);

    // Minutes later, still unread: no new notice, and running the job again sends nothing.
    await send('Third');
    expect(await unreadJobs()).toHaveLength(1);
    await runJob(job!);
    expect(await bellNotices(host._id)).toHaveLength(1);
  });

  it('sends another notice for a message the next day, while the first is still unread', async () => {
    const { host, booking, send } = await trip();
    await send('Is the car ready?');
    await runJob((await unreadJobs())[0]!);
    await noticeWentOut(booking, UNREAD_NOTICE_COOLDOWN_MS + HOUR_MS);

    await send('Hello? Picking up tomorrow.');
    const jobs = await unreadJobs();
    expect(jobs).toHaveLength(2);
    await runJob(jobs[1]!);
    const notices = await bellNotices(host._id);
    expect(notices.map((notice) => notice.payload)).toEqual([
      expect.objectContaining({ title: 'New message from Kiri' }),
      expect.objectContaining({ title: '2 new messages from Kiri', body: 'Hello? Picking up tomorrow.' }),
    ]);
    // By email and text too.
    expect(
      await NotificationModel.countDocuments({ userId: host._id, type: 'NEW_MESSAGE', channel: 'EMAIL' }),
    ).toBe(2);
  });

  it('starts again once the conversation has been read', async () => {
    const { host, asHost, booking, send } = await trip();
    await send('First');
    await runJob((await unreadJobs())[0]!);
    await readThread(asHost, booking.ref);

    await send('One more thing');
    const jobs = await unreadJobs();
    expect(jobs).toHaveLength(2);
    await runJob(jobs[1]!);
    expect(await bellNotices(host._id)).toHaveLength(2);
  });

  it('sends nothing once the recipient has blocked the sender', async () => {
    const { host, guest, send } = await trip();
    await send('Hi');
    await UserModel.updateOne({ _id: host._id }, { $addToSet: { blockedUserIds: guest._id } });
    await runJob((await unreadJobs())[0]!);
    expect(await NotificationModel.countDocuments({ type: 'NEW_MESSAGE' })).toBe(0);
  });

  it('drops a held text once they turn those texts off, or block the sender', async () => {
    const { host, guest, send } = await trip();
    await send('Hi');
    await runJob((await unreadJobs())[0]!);
    const sms = await NotificationModel.findOne({ userId: host._id, channel: 'SMS' });
    expect(sms!.payload).toMatchObject({ whileOptedIn: 'unreadMessageSms' });

    await UserModel.updateOne({ _id: host._id }, { $set: { 'notificationPrefs.unreadMessageSms': false } });
    await sendNotificationJob({ notificationId: sms!.id }, context);
    expect(await NotificationModel.findById(sms!._id)).toMatchObject({
      status: 'CANCELLED',
      error: 'Turned off in their settings',
    });

    await UserModel.updateOne(
      { _id: host._id },
      { $set: { 'notificationPrefs.unreadMessageSms': true }, $addToSet: { blockedUserIds: guest._id } },
    );
    await NotificationModel.updateOne({ _id: sms!._id }, { $set: { status: 'QUEUED' } });
    await sendNotificationJob({ notificationId: sms!.id }, context);
    expect(await NotificationModel.findById(sms!._id)).toMatchObject({
      status: 'CANCELLED',
      error: 'They blocked the sender',
    });
  });

  it('sends each email with the notification as its idempotency key, so a retry sends it once', async () => {
    const { host, send } = await trip();
    await send('Hi');
    await runJob((await unreadJobs())[0]!);
    const email = await NotificationModel.findOne({ userId: host._id, channel: 'EMAIL' });
    const mailed = vi.spyOn(getMailer(), 'send').mockResolvedValue({ id: 'email-1', provider: 'console' });

    await sendNotificationJob({ notificationId: email!.id }, context);
    expect(mailed).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `notification:${email!.id}` }),
    );
  });

  it('passes the idempotency key to Resend, and sends without one as before', async () => {
    const resend = vi.fn().mockResolvedValue({ data: { id: 're_1' }, error: null });
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'x@example.com',
      client: { emails: { send: resend } } as never,
    });
    const email = { to: 'a@example.com', subject: 's', html: 'h', text: 't' };

    await mailer.send({ ...email, idempotencyKey: 'notification:1' });
    expect(resend).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 's' }), {
      idempotencyKey: 'notification:1',
    });
    await mailer.send(email);
    expect(resend.mock.lastCall).toHaveLength(1);
  });
});

describe('support opening a conversation', () => {
  const event = (visibility: 'BOTH' | 'GUEST' | 'HOST' | 'INTERNAL') => ({
    action: 'NOTE',
    visibility,
    attachments: [],
    createdAt: new Date(),
  });

  /** A booking with one case on it, reported by `reporter`, and an admin who opens its messages from it. */
  async function bookingWithCase(
    reporter: 'GUEST' | 'STAFF',
    visibilities: ('BOTH' | 'GUEST' | 'HOST' | 'INTERNAL')[],
  ) {
    const { booking, guest } = await trip();
    const staff = await createStaff();
    await IncidentModel.create({
      caseRef: 'IN-ABC123',
      bookingId: booking._id,
      reporterId: reporter === 'GUEST' ? guest._id : staff._id,
      type: 'OTHER',
      description: 'Something to check',
      events: visibilities.map(event),
    });
    const open = () => openThreadForStaff(staff.id, ['ADMIN'], booking.ref, 'INCIDENT:IN-ABC123');
    return { booking, guest, open };
  }

  it('refuses a case staff opened for the team only', async () => {
    const { open } = await bookingWithCase('STAFF', ['INTERNAL', 'INTERNAL']);
    await expect(open()).rejects.toMatchObject({ status: 403, code: 'NO_CONTEXT' });
  });

  it('opens from a case staff shared with the Guest or Host, or one they reported', async () => {
    expect((await (await bookingWithCase('STAFF', ['INTERNAL', 'HOST'])).open()).thread.role).toBe('STAFF');
    await IncidentModel.deleteMany({});
    await UserModel.deleteMany({});
    expect((await (await bookingWithCase('GUEST', ['INTERNAL'])).open()).thread.role).toBe('STAFF');
  });

  it('shows the newest 1,000 messages, oldest first', async () => {
    const { booking, guest, open } = await bookingWithCase('GUEST', ['BOTH']);
    const thread = await ThreadModel.create({ bookingId: booking._id, participantIds: [guest._id] });
    const start = Date.now() - 2 * HOUR_MS;
    await MessageModel.insertMany(
      Array.from({ length: 1001 }, (_, index) => ({
        threadId: thread._id,
        senderId: guest._id,
        body: `Message ${index + 1}`,
        attachments: [],
        systemGenerated: false,
        createdAt: new Date(start + index * 1000),
      })),
    );

    const { messages } = await open();
    expect(messages).toHaveLength(1000);
    expect(messages[0]!.body).toBe('Message 2');
    expect(messages.at(-1)!.body).toBe('Message 1001');
  });
});
