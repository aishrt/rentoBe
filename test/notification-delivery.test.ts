import { pino } from 'pino';
import { Webhook } from 'standardwebhooks';
import type Stripe from 'stripe';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import { consoleSmsOutbox } from '../src/integrations/sms/sms-sender.js';
import type { JobContext } from '../src/jobs/handlers/index.js';
import { sendNotificationJob } from '../src/jobs/handlers/notification-send.js';
import type { JobDocument } from '../src/jobs/job.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { twilioSignature } from '../src/modules/notifications/delivery-webhooks.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { notify } from '../src/modules/notifications/notify.js';
import { syncIdentity } from '../src/modules/users/identity.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { createStaff, createUser, staffAgent, testApp } from './helpers.js';

/* Delivery reports from Resend and Twilio, texts dropped after quiet hours, and verification notices (plan §7). */

const RESEND_SECRET = `whsec_${Buffer.from('a-test-signing-key-of-32-bytes!!').toString('base64')}`;
const TWILIO_TOKEN = 'twilio-test-auth-token-0123456789abcdef';
const API_URL = 'https://api.example.co.nz';
const app = testApp();
const context = {
  job: { attempts: 1, maxAttempts: 5 } as JobDocument,
  log: pino({ level: 'silent' }),
} as JobContext;

const saved = {
  resend: env.RESEND_WEBHOOK_SECRET,
  twilio: env.TWILIO_AUTH_TOKEN,
  api: env.API_PUBLIC_URL,
};
beforeEach(() => {
  env.RESEND_WEBHOOK_SECRET = RESEND_SECRET;
  env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  env.API_PUBLIC_URL = API_URL;
});
afterEach(() => {
  env.RESEND_WEBHOOK_SECRET = saved.resend;
  env.TWILIO_AUTH_TOKEN = saved.twilio;
  env.API_PUBLIC_URL = saved.api;
  vi.restoreAllMocks();
});

/** Posts an event the way Resend does: Standard Webhooks headers over the raw JSON body, from its servers. */
function resend(
  event: object,
  { secret = RESEND_SECRET, at = new Date(), id = `msg_${Math.random()}` } = {},
) {
  const body = JSON.stringify(event);
  const signature = new Webhook(secret).sign(id, at, body);
  return request(app)
    .post('/api/v1/webhooks/resend')
    .set('Content-Type', 'application/json')
    .set('svix-id', id)
    .set('svix-timestamp', String(Math.floor(at.getTime() / 1000)))
    .set('svix-signature', signature)
    .send(body);
}

function twilio(params: Record<string, string>, token = TWILIO_TOKEN) {
  return request(app)
    .post('/api/v1/webhooks/twilio')
    .type('form')
    .set('X-Twilio-Signature', twilioSignature(`${API_URL}/api/v1/webhooks/twilio`, params, token))
    .send(params);
}

async function sentEmail(userId: unknown, providerRef: string) {
  return NotificationModel.create({
    userId,
    type: 'BOOKING_CONFIRMED',
    channel: 'EMAIL',
    status: 'SENT',
    providerRef,
    payload: {},
  });
}

describe('Resend delivery webhook', () => {
  it('marks an email delivered, and records a bounce for staff until the address works again', async () => {
    const kiri = await createUser();
    const email = await sentEmail(kiri._id, 'em_1');
    const to = ['kiri@example.co.nz'];

    expect(
      (
        await resend({
          type: 'email.delivered',
          created_at: '2026-10-08T01:00:00Z',
          data: { email_id: 'em_1', to },
        })
      ).status,
    ).toBe(200);
    expect((await NotificationModel.findById(email._id))!.status).toBe('DELIVERED');

    // A late bounce still counts, and staff see it on the person's record.
    const bounce = { type: 'Permanent', subType: 'General', message: 'Mailbox does not exist' };
    await resend({
      type: 'email.bounced',
      created_at: '2026-10-08T02:00:00Z',
      data: { email_id: 'em_1', to, bounce },
    });
    const failed = await NotificationModel.findById(email._id);
    expect(failed).toMatchObject({ status: 'FAILED' });
    expect(failed!.error).toContain('Mailbox does not exist');
    expect((await UserModel.findById(kiri._id))!.emailProblem).toMatchObject({ kind: 'BOUNCED' });

    await createStaff();
    const staff = await staffAgent();
    const record = await staff.get(`/api/v1/admin/users/${kiri.id}`);
    expect(record.body.user.emailProblem).toMatchObject({
      kind: 'BOUNCED',
      detail: expect.stringContaining('Mailbox'),
    });

    // A delivery report never undoes a failure, and an older delivery doesn't clear a newer bounce…
    await resend({
      type: 'email.delivered',
      created_at: '2026-10-08T01:30:00Z',
      data: { email_id: 'em_1', to },
    });
    expect((await NotificationModel.findById(email._id))!.status).toBe('FAILED');
    expect((await UserModel.findById(kiri._id))!.emailProblem).toBeDefined();

    // …but a later email delivered to the address clears it.
    await sentEmail(kiri._id, 'em_2');
    await resend({
      type: 'email.delivered',
      created_at: '2026-10-09T01:00:00Z',
      data: { email_id: 'em_2', to },
    });
    expect((await UserModel.findById(kiri._id))!.emailProblem).toBeUndefined();
  });

  it('turns off marketing emails after a spam complaint, and records a suppressed address', async () => {
    const kiri = await createUser();
    await UserModel.updateOne({ _id: kiri._id }, { $set: { 'notificationPrefs.marketingEmail': true } });
    const to = ['KIRI@example.co.nz'];

    await resend({
      type: 'email.complained',
      created_at: '2026-10-08T01:00:00Z',
      data: { email_id: 'em_9', to },
    });
    expect((await UserModel.findById(kiri._id))!.notificationPrefs.marketingEmail).toBe(false);

    const email = await sentEmail(kiri._id, 'em_3');
    await resend({
      type: 'email.suppressed',
      created_at: '2026-10-08T03:00:00Z',
      data: { email_id: 'em_3', to, suppressed: { type: 'complaint', message: 'On the suppression list' } },
    });
    expect((await NotificationModel.findById(email._id))!.status).toBe('FAILED');
    expect((await UserModel.findById(kiri._id))!.emailProblem).toMatchObject({ kind: 'SUPPRESSED' });
  });

  it('refuses an unsigned, wrongly signed or stale event, and answers 503 without a secret', async () => {
    const event = { type: 'email.delivered', data: { email_id: 'em_1', to: [] } };
    const unsigned = await request(app)
      .post('/api/v1/webhooks/resend')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
    expect(unsigned.status).toBe(400);

    const other = `whsec_${Buffer.from('another-key-another-key-another!').toString('base64')}`;
    expect((await resend(event, { secret: other })).body.error.code).toBe('INVALID_SIGNATURE');
    expect((await resend(event, { at: new Date(Date.now() - 10 * 60_000) })).status).toBe(400);

    env.RESEND_WEBHOOK_SECRET = undefined;
    expect((await resend(event)).status).toBe(503);
  });
});

describe('Twilio status callback', () => {
  it('records delivered and failed texts, and refuses a bad signature', async () => {
    const kiri = await createUser();
    const [delivered, failed] = await NotificationModel.create([
      {
        userId: kiri._id,
        type: 'PICKUP_REMINDER',
        channel: 'SMS',
        status: 'SENT',
        providerRef: 'SM1',
        payload: {},
      },
      {
        userId: kiri._id,
        type: 'PICKUP_REMINDER',
        channel: 'SMS',
        status: 'SENT',
        providerRef: 'SM2',
        payload: {},
      },
    ]);

    expect((await twilio({ MessageSid: 'SM1', MessageStatus: 'sent' })).status).toBe(204);
    expect((await NotificationModel.findById(delivered!._id))!.status).toBe('SENT');
    await twilio({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect((await NotificationModel.findById(delivered!._id))!.status).toBe('DELIVERED');

    await twilio({ MessageSid: 'SM2', MessageStatus: 'undelivered', ErrorCode: '30003' });
    expect(await NotificationModel.findById(failed!._id)).toMatchObject({
      status: 'FAILED',
      error: 'Text undelivered (Twilio error 30003)',
    });

    const forged = await twilio(
      { MessageSid: 'SM1', MessageStatus: 'failed' },
      'not-the-real-token-0123456789abcdef',
    );
    expect(forged.status).toBe(400);
    expect((await NotificationModel.findById(delivered!._id))!.status).toBe('DELIVERED');
  });
});

describe('texts held for quiet hours', () => {
  async function hostWithRequest() {
    const host = await createHost();
    await UserModel.updateOne(
      { _id: host._id },
      { $set: { phone: '+64211234567', phoneVerifiedAt: new Date() } },
    );
    const guest = await createUser({ email: 'mere@example.co.nz', firstName: 'Mere' });
    const vehicle = await createVehicle(host._id);
    const booking = await createBookingRecord(
      { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'PENDING', requestExpiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
    );
    return { host, booking };
  }

  async function queueRequestText(hostId: unknown, bookingId: unknown, dedupeKey: string) {
    await notify({
      userId: hostId as string,
      type: 'BOOKING_REQUEST',
      title: 'Booking request',
      sms: { body: `Request ${dedupeKey}`, whileBooking: { id: bookingId as string, statuses: ['PENDING'] } },
      dedupeKey,
    });
    return (await NotificationModel.findOne({ dedupeKey, channel: 'SMS' }))!;
  }

  it('sends a request text while the request waits, and drops it once the booking has moved on', async () => {
    const { host, booking } = await hostWithRequest();
    const outbox = consoleSmsOutbox();
    const before = outbox.length;

    const waiting = await queueRequestText(host._id, booking._id, 'REQUEST:1');
    await sendNotificationJob({ notificationId: waiting.id }, context);
    expect((await NotificationModel.findById(waiting._id))!.status).toBe('SENT');
    expect(outbox.slice(before).map((text) => text.body)).toEqual(['Request REQUEST:1']);

    const late = await queueRequestText(host._id, booking._id, 'REQUEST:2');
    await BookingModel.updateOne({ _id: booking._id }, { $set: { status: 'CANCELLED' } });
    await sendNotificationJob({ notificationId: late.id }, context);
    expect(await NotificationModel.findById(late._id)).toMatchObject({
      status: 'CANCELLED',
      error: 'The booking has moved on',
    });
    expect(outbox.slice(before)).toHaveLength(1);
  });

  it('drops a text that would arrive after the time it was about', async () => {
    const { host } = await hostWithRequest();
    await notify({
      userId: host._id,
      type: 'RETURN_REMINDER',
      title: 'Return reminder',
      sms: { body: 'Return by 6 am', expiresAt: new Date(Date.now() - 60_000) },
      dedupeKey: 'RETURN:1',
    });
    const text = (await NotificationModel.findOne({ dedupeKey: 'RETURN:1', channel: 'SMS' }))!;
    await sendNotificationJob({ notificationId: text.id }, context);
    expect((await NotificationModel.findById(text._id))!.status).toBe('CANCELLED');
  });
});

describe('verification notices', () => {
  beforeEach(() => {
    vi.spyOn(stripe().identity.verificationSessions, 'retrieve').mockImplementation(
      async () =>
        ({
          id: 'vs_1',
          status: 'requires_input',
          last_error: { code: 'document_expired', reason: 'The document has expired.' },
        }) as Stripe.Response<Stripe.Identity.VerificationSession>,
    );
  });

  it('tells someone by email and on the bell when Stripe needs them to try again', async () => {
    const kiri = await createUser();
    await UserModel.updateOne(
      { _id: kiri._id },
      { $set: { identityVerification: { status: 'NONE', providerRef: 'vs_1', startedAt: new Date() } } },
    );

    await syncIdentity(kiri.id);
    await syncIdentity(kiri.id);

    const notices = await NotificationModel.find({ userId: kiri._id, type: 'IDENTITY_RETRY' }).lean();
    expect(notices.map((notice) => notice.channel).sort()).toEqual(['EMAIL', 'IN_APP']);
    expect(notices.find((notice) => notice.channel === 'EMAIL')!.payload).toMatchObject({
      template: 'tripNotice',
      props: { heading: 'Please try your identity check again', url: expect.stringContaining('/account') },
    });
  });
});
