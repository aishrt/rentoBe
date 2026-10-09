import request from 'supertest';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/env.js';
import { stripe } from '../src/integrations/stripe.js';
import { JobModel } from '../src/jobs/job.model.js';
import { runDataRetention } from '../src/modules/admin/data-retention.service.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { MessageModel } from '../src/modules/messages/message.model.js';
import { ThreadModel } from '../src/modules/messages/thread.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { syncIdentity } from '../src/modules/users/identity.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const client = stripe();
const app = testApp();

let session: Partial<Stripe.Identity.VerificationSession> = {};
let report: Partial<Stripe.Identity.VerificationReport> = {};

beforeEach(() => {
  session = { id: 'vs_1', status: 'requires_input', url: 'https://verify.stripe.com/start/abc' };
  report = {};
  vi.spyOn(client.identity.verificationSessions, 'create').mockImplementation(
    async () => session as Stripe.Response<Stripe.Identity.VerificationSession>,
  );
  vi.spyOn(client.identity.verificationSessions, 'retrieve').mockImplementation(
    async () => session as Stripe.Response<Stripe.Identity.VerificationSession>,
  );
  vi.spyOn(client.identity.verificationReports, 'retrieve').mockImplementation(
    async () => report as Stripe.Response<Stripe.Identity.VerificationReport>,
  );
  vi.spyOn(client.identity.verificationSessions, 'redact').mockImplementation(
    async () => ({ ...session, status: 'verified' }) as Stripe.Response<Stripe.Identity.VerificationSession>,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function guestWithLicence() {
  const user = await createUser();
  const agent = browserAgent();
  await agent.post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  const saved = await agent.put('/api/v1/me/driver-licence').send({
    number: 'AB123456',
    version: '123',
    class: 'NZ_FULL',
    issuedAt: '2012-05-01',
    expiry: '2034-05-01',
    dob: '1990-04-21',
  });
  expect(saved.status).toBe(200);
  return { user, agent };
}

const licenceReport = (number: string) =>
  ({
    id: 'vr_1',
    document: { type: 'driving_license', number, dob: { year: 1990, month: 4, day: 21 } },
  }) as unknown as Partial<Stripe.Identity.VerificationReport>;

describe('the identity check', () => {
  it('starts on Stripe’s page, and checkout says what’s needed until it passes', async () => {
    const { agent, user } = await guestWithLicence();
    const readiness = await agent.get('/api/v1/me/checkout');
    expect(readiness.body.problems.map((problem: { code: string }) => problem.code)).toContain(
      'IDENTITY_REQUIRED',
    );

    const started = await agent.post('/api/v1/me/verification').send({ returnTo: '/book/abc?x=1' });
    expect(started.body.url).toBe('https://verify.stripe.com/start/abc');
    expect(client.identity.verificationSessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document',
        return_url: 'http://localhost:5173/book/abc?x=1',
        options: expect.objectContaining({
          document: expect.objectContaining({ require_matching_selfie: true }),
        }),
      }),
    );
    expect((await UserModel.findById(user._id))!.identityVerification).toMatchObject({
      providerRef: 'vs_1',
      status: 'NONE',
      sessionStatus: 'requires_input',
    });

    // Stripe is checking: checkout waits.
    session = { ...session, status: 'processing' };
    expect((await agent.get('/api/v1/me/verification')).body.identity).toMatchObject({
      sessionStatus: 'processing',
    });
    const waiting = await agent.get('/api/v1/me/checkout');
    expect(waiting.body.identityProcessing).toBe(true);
    expect(waiting.body.problems.map((problem: { code: string }) => problem.code)).toContain(
      'IDENTITY_PROCESSING',
    );

    // Verified with the same licence: the licence is confirmed too.
    session = { ...session, status: 'verified', last_verification_report: 'vr_1' };
    report = licenceReport('AB123456');
    expect((await agent.get('/api/v1/me/verification')).body.identity).toMatchObject({
      status: 'APPROVED',
      documentType: 'driving_license',
    });
    const fresh = await UserModel.findById(user._id);
    expect(fresh!.driverLicence!.status).toBe('APPROVED');
    expect((await agent.get('/api/v1/me/checkout')).body.problems).toEqual([
      { code: 'PHONE_REQUIRED', message: 'Verify your mobile number.' },
    ]);
    expect((await agent.post('/api/v1/me/verification').send({})).body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('sends a mismatched licence number to support, and lets someone retry an abandoned check', async () => {
    const { user, agent } = await guestWithLicence();
    await createStaff('aroha@example.co.nz', 'ADMIN');
    await agent.post('/api/v1/me/verification').send({});

    session = {
      ...session,
      status: 'requires_input',
      last_error: { code: 'consent_declined', reason: 'You declined consent.' },
    };
    await syncIdentity(user.id);
    expect((await agent.get('/api/v1/me/checkout')).body.identityError).toBe('You declined consent.');

    session = { ...session, status: 'verified', last_error: null, last_verification_report: 'vr_1' };
    report = licenceReport('ZZ999999');
    await syncIdentity(user.id);
    expect((await UserModel.findById(user._id))!.identityVerification).toMatchObject({
      status: 'PENDING',
      reviewReason: 'The licence number on the ID doesn’t match the one entered.',
    });
    expect(await NotificationModel.countDocuments({ type: 'IDENTITY_REVIEW', channel: 'EMAIL' })).toBe(1);

    const staff = await staffAgent();
    const queue = await staff.get('/api/v1/admin/verifications');
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        userId: user.id,
        kind: 'IDENTITY',
        reason: expect.stringMatching(/licence number/),
      }),
    ]);
    const approved = await staff
      .post(`/api/v1/admin/users/${user.id}/identity-review`)
      .send({ decision: 'APPROVE' });
    expect(approved.body.identityStatus).toBe('APPROVED');
    expect(
      await NotificationModel.countDocuments({
        userId: user._id,
        type: 'IDENTITY_APPROVED',
        channel: 'EMAIL',
      }),
    ).toBe(1);
  });

  it('applies Stripe’s webhooks through a job, and support can check a licence by hand', async () => {
    const { user } = await guestWithLicence();
    const payload = JSON.stringify({
      id: 'evt_identity',
      object: 'event',
      type: 'identity.verification_session.verified',
      api_version: '2026-08-26.dahlia',
      created: 1_790_000_000,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: 'vs_1',
          object: 'identity.verification_session',
          status: 'verified',
          metadata: { userId: user.id },
        },
      },
    });
    const delivered = await request(app)
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'Stripe-Signature',
        Stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET! }),
      )
      .send(payload);
    expect(delivered.status).toBe(200);
    expect(await JobModel.countDocuments({ type: 'identity.sync', 'payload.userId': user.id })).toBe(1);

    // A passport passed: the licence still needs a person to check it.
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { identityVerification: { status: 'APPROVED', documentType: 'passport' } } },
    );
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    expect((await staff.get('/api/v1/admin/verifications')).body.items[0]).toMatchObject({ kind: 'LICENCE' });
    const decided = await staff
      .post(`/api/v1/admin/users/${user.id}/licence-review`)
      .send({ decision: 'REJECT', note: 'The expiry date doesn’t match the card.' });
    expect(decided.body.licenceStatus).toBe('REJECTED');
    expect(await AuditLogModel.countDocuments({ action: 'licence.rejected' })).toBe(1);
  });

  it('gives staff what to check a licence against, and the full number on request, logged each time', async () => {
    const { user, agent } = await guestWithLicence();
    await agent.post('/api/v1/me/verification').send({});
    session = { ...session, status: 'verified', last_verification_report: 'vr_1' };
    report = licenceReport('ZZ999999');
    await syncIdentity(user.id);
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();

    // The identity check comes first, with how the ID compared and the licence's details.
    const licence = {
      class: 'NZ_FULL',
      country: 'New Zealand',
      numberEnding: '456',
      version: '123',
      issuedAt: '2012-05-01',
      expiry: '2034-05-01',
      status: 'PENDING',
    };
    expect((await staff.get('/api/v1/admin/verifications')).body.items).toEqual([
      expect.objectContaining({
        kind: 'IDENTITY',
        identity: {
          status: 'PENDING',
          documentType: 'driving_license',
          licenceNumberMatched: false,
          dobMatched: true,
        },
        licence,
        dob: '1990-04-21',
      }),
    ]);
    await staff.post(`/api/v1/admin/users/${user.id}/identity-review`).send({ decision: 'APPROVE' });
    // Support's decision keeps the check's start time and what the document showed.
    expect((await UserModel.findById(user._id).lean())!.identityVerification).toMatchObject({
      status: 'APPROVED',
      startedAt: expect.any(Date),
      documentType: 'driving_license',
    });

    // Then the licence the ID didn't confirm.
    expect((await staff.get('/api/v1/admin/verifications')).body.items).toEqual([
      expect.objectContaining({
        kind: 'LICENCE',
        reason: expect.stringMatching(/different number/),
        identity: expect.objectContaining({ status: 'APPROVED', licenceNumberMatched: false }),
      }),
    ]);
    const record = await staff.get(`/api/v1/admin/users/${user.id}`);
    expect(record.body.user).toMatchObject({
      dob: '1990-04-21',
      licence,
      identityDocument: { type: 'driving_license', licenceNumberMatched: false, dobMatched: true },
    });

    // The full number, decrypted for staff, never cached, and in the audit log each time.
    const shown = await staff.get(`/api/v1/admin/users/${user.id}/licence-number`);
    expect(shown.body).toEqual({ number: 'AB123456' });
    expect(shown.headers['cache-control']).toBe('no-store');
    await staff.get(`/api/v1/admin/users/${user.id}/licence-number`);
    expect(await AuditLogModel.countDocuments({ action: 'licence.number-viewed', entityId: user.id })).toBe(
      2,
    );
    expect((await agent.get(`/api/v1/admin/users/${user.id}/licence-number`)).status).toBe(403);
  });

  it('queues a licence for a person only when no identity check is still to confirm it', async () => {
    const { user } = await guestWithLicence();
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    // The identity check is needed before booking and may read the licence itself.
    expect((await staff.get('/api/v1/admin/verifications')).body.items).toEqual([]);

    // With no identity check needed, the licence goes to support straight away.
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { verification: { identityBeforeFirstBooking: false } },
    });
    expect((await staff.get('/api/v1/admin/verifications')).body.items).toEqual([
      expect.objectContaining({
        userId: user.id,
        kind: 'LICENCE',
        identity: { status: 'NONE' },
        reason: expect.stringMatching(/No identity check/),
      }),
    ]);
  });
});

describe('data retention', () => {
  it('redacts ID images after 90 days and clears old trip records, keeping open cases', async () => {
    const user = await createUser();
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          identityVerification: {
            status: 'APPROVED',
            providerRef: 'vs_old',
            verifiedAt: new Date(Date.now() - 91 * DAY_MS),
          },
        },
      },
    );
    // Checks that never passed go 90 days after they began, unless support is still reviewing one.
    const turnedDown = await createUser({ email: 'turned.down@example.co.nz' });
    const reviewing = await createUser({ email: 'reviewing@example.co.nz' });
    const recent = await createUser({ email: 'recent@example.co.nz' });
    for (const [person, status, providerRef, days] of [
      [turnedDown, 'REJECTED', 'vs_rejected', 91],
      [reviewing, 'PENDING', 'vs_reviewing', 91],
      [recent, 'NONE', 'vs_recent', 10],
    ] as const) {
      await UserModel.updateOne(
        { _id: person._id },
        {
          $set: {
            identityVerification: { status, providerRef, startedAt: new Date(Date.now() - days * DAY_MS) },
          },
        },
      );
    }
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const ended = new Date(Date.now() - 800 * DAY_MS);
    const booking = await createBookingRecord(
      { guestId: user._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'COMPLETED', startAt: new Date(ended.getTime() - 3 * DAY_MS), endAt: ended },
    );
    const thread = await ThreadModel.create({ bookingId: booking._id, participantIds: [user._id, host._id] });
    await MessageModel.create({ threadId: thread._id, senderId: user._id, body: 'See you then' });
    await ConditionReportModel.create({
      bookingId: booking._id,
      stage: 'CHECK_IN',
      odometer: 1,
      fuelOrBatteryPct: 50,
      photos: [
        { angle: 'FRONT', url: 'local:bookings/x/inspections/a.jpg', takenBy: host._id, takenAt: ended },
      ],
    });

    const result = await runDataRetention();
    expect(result).toMatchObject({ identitiesRedacted: 2, tripsCleared: 1 });
    expect(client.identity.verificationSessions.redact).toHaveBeenCalledWith('vs_old');
    expect(client.identity.verificationSessions.redact).toHaveBeenCalledWith('vs_rejected');
    expect(client.identity.verificationSessions.redact).toHaveBeenCalledTimes(2);
    expect(await MessageModel.countDocuments({})).toBe(0);
    expect((await ConditionReportModel.findOne({ bookingId: booking._id }))!.photos).toEqual([]);
    expect(await JobModel.countDocuments({ type: 'daily.dataRetention' })).toBe(1);
    // Done once.
    expect(await runDataRetention()).toMatchObject({ identitiesRedacted: 0, tripsCleared: 0 });
  });

  it('redacts a check support turned down, and each one started again, 90 days after it began', async () => {
    const { user, agent } = await guestWithLicence();
    session = { id: 'vs_first', status: 'requires_input', url: 'https://verify.stripe.com/start/first' };
    await agent.post('/api/v1/me/verification').send({});
    // They gave up on the first check and started again: the first may hold images too.
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { 'identityVerification.sessionStatus': 'canceled' } },
    );
    session = { id: 'vs_second', status: 'requires_input', url: 'https://verify.stripe.com/start/second' };
    await agent.post('/api/v1/me/verification').send({});
    expect((await UserModel.findById(user._id).lean())!.identityVerification).toMatchObject({
      providerRef: 'vs_second',
      earlierSessions: [{ providerRef: 'vs_first', startedAt: expect.any(Date) }],
    });

    // The second needs a person, and support turns it down.
    session = {
      ...session,
      last_error: { code: 'selfie_face_mismatch', reason: 'The selfie doesn’t match the ID.' },
    } as Partial<Stripe.Identity.VerificationSession>;
    await syncIdentity(user.id);
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    const rejected = await staff
      .post(`/api/v1/admin/users/${user.id}/identity-review`)
      .send({ decision: 'REJECT' });
    expect(rejected.body.identityStatus).toBe('REJECTED');
    expect((await UserModel.findById(user._id).lean())!.identityVerification!.startedAt).toBeDefined();

    // Not yet 90 days: both keep their images.
    expect(await runDataRetention(new Date(Date.now() + 10 * DAY_MS))).toMatchObject({
      identitiesRedacted: 0,
    });
    const later = new Date(Date.now() + 91 * DAY_MS);
    expect(await runDataRetention(later)).toMatchObject({ identitiesRedacted: 2 });
    expect(client.identity.verificationSessions.redact).toHaveBeenCalledWith('vs_second');
    expect(client.identity.verificationSessions.redact).toHaveBeenCalledWith('vs_first');
    const identity = (await UserModel.findById(user._id).lean())!.identityVerification!;
    expect(identity.redactedAt).toBeDefined();
    expect(identity.earlierSessions![0]!.redactedAt).toBeDefined();
    expect(await AuditLogModel.countDocuments({ action: 'identity.redacted', entityId: user.id })).toBe(2);
    // Done once.
    expect(await runDataRetention(later)).toMatchObject({ identitiesRedacted: 0 });
  });
});
