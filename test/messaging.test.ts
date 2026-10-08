import { describe, expect, it, vi } from 'vitest';
import { withTransaction } from '../src/db.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { unreadMessageEmailJob } from '../src/jobs/handlers/message-jobs.js';
import { pickupReminderJob, startCheckJob } from '../src/jobs/handlers/trip-jobs.js';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { confirmBooking, endBooking } from '../src/modules/bookings/booking-transitions.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { maskContactDetails, MASKED } from '../src/modules/messages/masking.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { ReportModel } from '../src/modules/moderation/report.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createPaymentRecord, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const context = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as JobContext;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A Guest, a Host and their booking, both signed in. */
async function trip(overrides: Parameters<typeof createBookingRecord>[1] = {}) {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  await UserModel.updateOne(
    { _id: guest._id },
    { $set: { phone: '+64211112222', phoneVerifiedAt: new Date(), emailVerifiedAt: new Date() } },
  );
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    overrides,
  );
  return {
    host,
    guest,
    booking,
    guestAgent: await signIn('kiri@example.co.nz'),
    hostAgent: await signIn('hana@example.co.nz'),
  };
}

describe('contact details in messages', () => {
  it('hides phone numbers, emails and links, and leaves ordinary text alone', () => {
    expect(maskContactDetails('Text me on 021 123 4567 or +64 21 123 4567')).toBe(
      `Text me on ${MASKED} or ${MASKED}`,
    );
    expect(maskContactDetails('kiri@example.co.nz, kiri (at) example (dot) com')).toBe(
      `${MASKED}, ${MASKED}`,
    );
    expect(maskContactDetails('see www.example.com or https://x.io/a and rentovroom.co.nz')).toBe(
      `see ${MASKED} or ${MASKED} and ${MASKED}`,
    );
    expect(maskContactDetails('Pick-up at 10:30 on 12/10/2026, about 45,000 km on the clock.')).toBe(
      'Pick-up at 10:30 on 12/10/2026, about 45,000 km on the clock.',
    );
  });
});

describe('booking messages', () => {
  it('lets the guest and host talk, with unread counts, read receipts and the inbox', async () => {
    const { booking, guestAgent, hostAgent } = await trip();

    const sent = await guestAgent
      .post(`/api/v1/threads/${booking.ref}/messages`)
      .send({ body: 'Kia ora! Can I pick up at 10:30? Call me on 021 111 2222.' });
    expect(sent.status).toBe(201);
    // Confirmed: contact details show.
    expect(sent.body.message).toMatchObject({
      from: 'ME',
      sender: 'GUEST',
      body: expect.stringContaining('021'),
    });

    expect((await hostAgent.get('/api/v1/threads/unread')).body.count).toBe(1);
    const inbox = await hostAgent.get('/api/v1/threads');
    expect(inbox.body.unreadTotal).toBe(1);
    expect(inbox.body.threads[0]).toMatchObject({
      ref: booking.ref,
      role: 'HOST',
      otherParty: { firstName: 'Kiri' },
      unreadCount: 1,
      readOnly: false,
      lastMessage: { from: 'THEM', hasPhotos: false },
    });

    const thread = await hostAgent.get(`/api/v1/threads/${booking.ref}`);
    expect(thread.body.thread).toMatchObject({ canSend: true, contactsHidden: false, blockedByMe: false });

    expect((await hostAgent.post(`/api/v1/threads/${booking.ref}/read`)).status).toBe(204);
    expect((await hostAgent.get('/api/v1/threads/unread')).body.count).toBe(0);
    await hostAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'Sure, see you then.' });

    const history = await guestAgent.get(`/api/v1/threads/${booking.ref}/messages`);
    expect(history.body.hasMore).toBe(false);
    expect(history.body.messages.map((message: { body: string; from: string }) => message.from)).toEqual([
      'ME',
      'THEM',
    ]);
    // The host read it: the guest sees "Seen".
    expect(history.body.messages[0].readAt).toEqual(expect.any(String));
  });

  it('hides contact details until the booking is confirmed', async () => {
    const { booking, guestAgent, hostAgent } = await trip({
      status: 'PENDING',
      instantBook: false,
      requestExpiresAt: new Date(Date.now() + DAY_MS),
    });
    await guestAgent
      .post(`/api/v1/threads/${booking.ref}/messages`)
      .send({ body: 'My number is 021 111 2222' });
    const seen = await hostAgent.get(`/api/v1/threads/${booking.ref}/messages`);
    expect(seen.body.messages[0].body).toBe(`My number is ${MASKED}`);
    expect((await hostAgent.get(`/api/v1/threads/${booking.ref}`)).body.thread.contactsHidden).toBe(true);

    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'CONFIRMED' } });
    const confirmed = await hostAgent.get(`/api/v1/threads/${booking.ref}/messages`);
    expect(confirmed.body.messages[0].body).toBe('My number is 021 111 2222');
  });

  it('has no thread for an unpaid checkout, and none for people outside the booking', async () => {
    const { booking, guestAgent } = await trip({ status: 'PAYMENT_PENDING' });
    expect((await guestAgent.get(`/api/v1/threads/${booking.ref}`)).body.error.code).toBe('NO_THREAD');

    await createUser({ email: 'nosy@example.co.nz' });
    const nosy = await signIn('nosy@example.co.nz');
    expect((await nosy.get(`/api/v1/threads/${booking.ref}`)).status).toBe(404);
    expect((await nosy.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'hi' })).status).toBe(
      404,
    );
  });

  it('becomes read-only 30 days after the trip, unless an incident is open', async () => {
    const ended = new Date(Date.now() - 31 * DAY_MS);
    const { booking, guestAgent, guest } = await trip({
      status: 'COMPLETED',
      startAt: new Date(ended.getTime() - 3 * DAY_MS),
      endAt: ended,
    });
    const closed = await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'Thanks!' });
    expect(closed.body.error.code).toBe('THREAD_CLOSED');
    expect((await guestAgent.get(`/api/v1/threads/${booking.ref}`)).body.thread).toMatchObject({
      readOnly: true,
      canSend: false,
    });

    await IncidentModel.create({
      caseRef: 'IN-ABC234',
      bookingId: booking._id,
      reporterId: guest._id,
      type: 'DAMAGE',
      description: 'A scratch on the door',
    });
    expect(
      (await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'About the scratch' }))
        .status,
    ).toBe(201);
  });

  it('sends photos through private, expiring links', async () => {
    const { booking, guestAgent } = await trip();
    const photo = Buffer.from('fake-jpeg');
    const target = await guestAgent.post('/api/v1/uploads/signature').send({
      purpose: 'MESSAGE_PHOTO',
      bookingId: booking.ref,
      contentType: 'image/jpeg',
      size: photo.length,
    });
    expect(target.status).toBe(200);
    expect(target.body.key).toMatch(new RegExp(`^bookings/${booking.id}/messages/`));
    await guestAgent.put(new URL(target.body.url).pathname).set('Content-Type', 'image/jpeg').send(photo);

    const sent = await guestAgent
      .post(`/api/v1/threads/${booking.ref}/messages`)
      .send({ attachments: [{ key: target.body.key, contentType: 'image/jpeg' }] });
    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments[0].url).toMatch(/\/api\/v1\/files\/private\/bookings\/.+\?e=\d+&s=/);

    // Another booking's folder can't be attached.
    const elsewhere = await guestAgent
      .post(`/api/v1/threads/${booking.ref}/messages`)
      .send({ attachments: [{ key: 'bookings/0123456789abcdef01234567/messages/x.jpg' }] });
    expect(elsewhere.status).toBe(400);
    expect((await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({})).status).toBe(400);
  });

  it('stops messages once either side blocks the other, but system messages still arrive', async () => {
    const { booking, guest, guestAgent, hostAgent } = await trip();
    expect((await hostAgent.post(`/api/v1/users/${guest.id}/block`)).status).toBe(204);

    const refused = await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'Hello?' });
    expect(refused.body.error.code).toBe('THREAD_CLOSED');
    expect((await hostAgent.get(`/api/v1/threads/${booking.ref}`)).body.thread).toMatchObject({
      blockedByMe: true,
      canSend: false,
    });
    expect((await hostAgent.get('/api/v1/me/blocked-users')).body.users).toEqual([
      { id: guest.id, firstName: 'Kiri' },
    ]);

    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 24 }, context);
    const thread = await ThreadModel.findOne({ bookingId: booking._id });
    expect(await MessageModel.countDocuments({ threadId: thread!._id, systemGenerated: true })).toBe(1);

    expect((await hostAgent.delete(`/api/v1/users/${guest.id}/block`)).status).toBe(204);
    expect(
      (await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'Hi' })).status,
    ).toBe(201);
  });

  it('reports a message to support, and flags someone several people report', async () => {
    const { booking, guest, guestAgent, hostAgent } = await trip();
    const sent = await guestAgent
      .post(`/api/v1/threads/${booking.ref}/messages`)
      .send({ body: 'Rude words' });

    const own = await guestAgent
      .post('/api/v1/reports')
      .send({ targetType: 'MESSAGE', targetId: sent.body.message.id, reason: 'HARASSMENT' });
    expect(own.body.error.code).toBe('OWN_CONTENT');
    const report = await hostAgent
      .post('/api/v1/reports')
      .send({ targetType: 'MESSAGE', targetId: sent.body.message.id, reason: 'HARASSMENT', note: 'Abusive' });
    expect(report.status).toBe(201);
    expect(await ReportModel.findById(report.body.id)).toMatchObject({
      subjectUserId: guest._id,
      status: 'OPEN',
    });

    for (const email of ['a@example.co.nz', 'b@example.co.nz']) {
      await createUser({ email });
      const reporter = await signIn(email);
      await reporter.post('/api/v1/reports').send({ targetType: 'USER', targetId: guest.id, reason: 'SCAM' });
    }
    const flagged = await UserModel.findById(guest._id);
    expect(flagged!.riskFlags.map((flag) => flag.code)).toEqual(['REPEATED_REPORTS']);
  });

  it('emails an unread message after 10 minutes, once per unread streak', async () => {
    const { booking, guestAgent, host } = await trip();
    await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'First' });
    await guestAgent.post(`/api/v1/threads/${booking.ref}/messages`).send({ body: 'Second' });
    const jobs = await JobModel.find({ type: 'messages.unreadEmail' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    await unreadMessageEmailJob(jobs[0]!.payload as { threadId: string; recipientId: string }, context);
    const sent = await NotificationModel.find({ userId: host._id, type: 'NEW_MESSAGE' });
    expect(sent.map((notification) => notification.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(sent.find((notification) => notification.channel === 'IN_APP')!.payload).toMatchObject({
      title: '2 new messages from Kiri',
      body: 'Second',
      link: `/messages/${booking.ref}`,
    });

    // Read before the 10 minutes were up: nothing is sent.
    await NotificationModel.deleteMany({});
    const hostAgent = await signIn('hana@example.co.nz');
    await hostAgent.post(`/api/v1/threads/${booking.ref}/read`);
    await unreadMessageEmailJob(jobs[0]!.payload as { threadId: string; recipientId: string }, context);
    expect(await NotificationModel.countDocuments({ type: 'NEW_MESSAGE' })).toBe(0);
  });

  it('lets support staff open a thread only from a report, incident or ticket about it', async () => {
    const { booking, guest } = await trip();
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();

    expect((await staff.get(`/api/v1/admin/bookings/${booking.ref}/thread`)).status).toBe(400);
    await SupportTicketModel.create({
      ref: 'ST-OTHER2',
      userId: guest._id,
      subject: 'Something else',
      messages: [{ body: 'Hi', createdAt: new Date() }],
    });
    const unrelated = await staff.get(
      `/api/v1/admin/bookings/${booking.ref}/thread?context=TICKET:ST-OTHER2`,
    );
    expect(unrelated.body.error.code).toBe('NO_CONTEXT');

    await SupportTicketModel.create({
      ref: 'ST-ABOUT2',
      userId: guest._id,
      bookingId: booking._id,
      subject: 'About my trip',
      messages: [{ body: 'Hi', createdAt: new Date() }],
    });
    const opened = await staff.get(`/api/v1/admin/bookings/${booking.ref}/thread?context=TICKET:ST-ABOUT2`);
    expect(opened.status).toBe(200);
    expect(opened.body.thread).toMatchObject({ role: 'STAFF', canSend: false });
    expect(await AuditLogModel.findOne({ action: 'thread.opened', entityId: booking.id })).toMatchObject({
      after: { context: 'TICKET:ST-ABOUT2' },
    });
  });
});

describe('automated booking messages and reminders', () => {
  it('posts the confirmation into the chat and queues the trip reminders, cancelled with the booking', async () => {
    const { booking } = await trip({ status: 'PAYMENT_PENDING' });
    const payment = await createPaymentRecord(booking);
    await withTransaction((session) => confirmBooking(booking, payment, session));

    const thread = await ThreadModel.findOne({ bookingId: booking._id });
    const messages = await MessageModel.find({ threadId: thread!._id });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toMatch(/^Booking confirmed/);
    const queued = await JobModel.find({
      refId: booking.id,
      status: 'QUEUED',
      type: /^(reminder|trip)\./,
    }).sort({
      runAt: 1,
    });
    expect(queued.map((job) => job.type)).toEqual([
      'reminder.pickup',
      'reminder.pickup',
      'trip.startCheck',
      'trip.startCheck',
      'reminder.return',
    ]);

    const fresh = await BookingModel.findById(booking._id);
    await withTransaction((session) =>
      endBooking(
        fresh!,
        {
          to: 'CANCELLED',
          from: ['CONFIRMED'],
          cancellation: {
            reason: 'HOST_CANCELLED',
            refundCents: 0,
            feeCents: 0,
            hostShareCents: 0,
            hostFeeCents: 0,
          },
        },
        session,
      ),
    );
    expect(
      await JobModel.countDocuments({ refId: booking.id, status: 'QUEUED', type: /^(reminder|trip)\./ }),
    ).toBe(0);
    expect((await MessageModel.find({ threadId: thread!._id }).sort({ createdAt: 1 })).at(-1)!.body).toMatch(
      /host cancelled/,
    );
  });

  it('reminds both sides before pick-up by email, text and chat, and skips a trip that moved on', async () => {
    const { booking, guest, host } = await trip();
    await UserModel.updateOne({ _id: guest._id }, { $unset: { emailVerifiedAt: 1 } });
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 24 }, context);
    const toGuest = await NotificationModel.find({ userId: guest._id, type: 'PICKUP_REMINDER' });
    expect(toGuest.map((notification) => notification.channel).sort()).toEqual(['EMAIL', 'IN_APP', 'SMS']);
    // An unconfirmed email address is asked for before the trip (plan §6.1).
    expect(toGuest.find((notification) => notification.channel === 'EMAIL')!.payload).toMatchObject({
      template: 'tripReminder',
      props: { verifyEmailUrl: expect.stringContaining('/account/settings') },
    });
    expect(await NotificationModel.countDocuments({ userId: host._id, type: 'PICKUP_REMINDER' })).toBe(2);

    // Again: nothing more is sent.
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 24 }, context);
    expect(await NotificationModel.countDocuments({ type: 'PICKUP_REMINDER' })).toBe(5);

    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'CANCELLED' } });
    await pickupReminderJob({ bookingId: booking.id, hoursBefore: 2 }, context);
    expect(await NotificationModel.countDocuments({ type: 'PICKUP_REMINDER' })).toBe(5);
  });

  it('reminds both sides when check-in is missing, then alerts support', async () => {
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { booking } = await trip({ startAt: start, endAt: new Date(start.getTime() + 3 * DAY_MS) });
    const admin = await createStaff('aroha@example.co.nz', 'ADMIN');
    await startCheckJob({ bookingId: booking.id, hoursAfter: 1 }, context);
    expect(await NotificationModel.countDocuments({ type: 'CHECK_IN_MISSING', channel: 'IN_APP' })).toBe(2);
    await startCheckJob({ bookingId: booking.id, hoursAfter: 2 }, context);
    expect(
      await NotificationModel.countDocuments({
        userId: admin._id,
        type: 'TRIP_NO_CHECK_IN',
        channel: 'EMAIL',
      }),
    ).toBe(1);
  });
});
