import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripe } from '../src/integrations/stripe.js';
import { nzDate } from '../src/lib/nz-time.js';
import { getPlatformSettings } from '../src/modules/admin/platform-settings.service.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import {
  documentDobHash,
  licenceNumberHash,
  verificationInReview,
} from '../src/modules/users/driver-licence.service.js';
import { syncIdentity } from '../src/modules/users/identity.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * Re-saving licence details (plan §3, validation rules: booking; plan §8.2): a review stands only for the
 * details it reviewed, a date of birth a passed ID check read can't be changed here, and an ID check never
 * overrides support's decision on a licence.
 */

type Agent = ReturnType<typeof browserAgent>;

const LICENCE = {
  number: 'AB123456',
  version: '123',
  class: 'NZ_FULL',
  issuedAt: '2012-05-01',
  expiry: '2034-05-01',
  dob: '1990-04-21',
};

async function guestWithLicence(details: Partial<typeof LICENCE> = {}) {
  const user = await createUser();
  const agent = browserAgent();
  await agent.post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  const saved = await agent.put('/api/v1/me/driver-licence').send({ ...LICENCE, ...details });
  expect(saved.status).toBe(200);
  return { user, agent };
}

/** As support or a passed ID check left it: the identity verified with a passport, the licence decided. */
async function decided(userId: unknown, licenceStatus: 'APPROVED' | 'REJECTED', identity: object = {}) {
  await UserModel.updateOne(
    { _id: userId },
    {
      $set: {
        'driverLicence.status': licenceStatus,
        identityVerification: { status: 'APPROVED', documentType: 'passport', ...identity },
      },
    },
  );
}

const save = (agent: Agent, details: Partial<typeof LICENCE> = {}) =>
  agent.put('/api/v1/me/driver-licence').send({ ...LICENCE, ...details });

const licenceStatus = async (userId: unknown) =>
  (await UserModel.findById(userId).lean())!.driverLicence!.status;

describe('re-saving licence details', () => {
  it('keeps the review for the same details, and checks any change again, even with the same number', async () => {
    const { user, agent } = await guestWithLicence();
    await decided(user._id, 'APPROVED');

    // Exactly the same details: the approval stands.
    const same = await save(agent);
    expect(same.status).toBe(200);
    expect(same.body.licence.status).toBe('APPROVED');
    expect(same.body.licenceInReview).toBe(false);

    // An earlier date of birth (which can beat the minimum age) goes back to support, and a booking made
    // now waits for them as a request.
    const older = await save(agent, { dob: '1985-04-21' });
    expect(older.body.licence.status).toBe('PENDING');
    expect(older.body.licenceInReview).toBe(true);
    const fresh = await UserModel.findById(user._id).lean();
    expect(verificationInReview(fresh!, await getPlatformSettings())).toBe(true);

    // A licence class that isn't accepted, changed to one that is.
    await decided(user._id, 'APPROVED');
    expect((await save(agent, { dob: '1985-04-21', class: 'NZ_RESTRICTED' })).body.licence.status).toBe(
      'PENDING',
    );
    await decided(user._id, 'APPROVED');
    expect((await save(agent, { dob: '1985-04-21' })).body.licence.status).toBe('PENDING');

    // A later expiry, or an earlier issue date, on the same card number.
    await decided(user._id, 'APPROVED');
    expect((await save(agent, { dob: '1985-04-21', expiry: '2036-05-01' })).body.licence.status).toBe(
      'PENDING',
    );
    await decided(user._id, 'APPROVED');
    expect(
      (await save(agent, { dob: '1985-04-21', expiry: '2036-05-01', issuedAt: '2005-05-01' })).body.licence
        .status,
    ).toBe('PENDING');

    // Saved again unchanged: still approved.
    await decided(user._id, 'APPROVED');
    expect(
      (await save(agent, { dob: '1985-04-21', expiry: '2036-05-01', issuedAt: '2005-05-01' })).body.licence
        .status,
    ).toBe('APPROVED');
  });

  it('sends a licence support turned down back to them once it’s corrected', async () => {
    const { user, agent } = await guestWithLicence();
    // The ID check read this very licence, so it would otherwise confirm it.
    await decided(user._id, 'REJECTED', {
      documentType: 'driving_license',
      documentNumberHash: licenceNumberHash(LICENCE.number),
      documentDobHash: documentDobHash(LICENCE.dob),
      documentDobMatched: true,
    });

    // Nothing changed: it stays turned down.
    const same = await save(agent);
    expect(same.body.licence.status).toBe('REJECTED');
    expect(same.body.problems.map((problem: { code: string }) => problem.code)).toContain('LICENCE_REJECTED');

    // Corrected: support checks it again, rather than the ID check approving it.
    const corrected = await save(agent, { expiry: '2035-05-01' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.licence.status).toBe('PENDING');
    expect(corrected.body.licenceInReview).toBe(true);
    expect(corrected.body.problems.map((problem: { code: string }) => problem.code)).not.toContain(
      'LICENCE_REJECTED',
    );
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    expect((await staff.get('/api/v1/admin/verifications')).body.items).toEqual([
      expect.objectContaining({ userId: user.id, kind: 'LICENCE' }),
    ]);
  });

  it('still lets a passed ID check confirm a new licence with the same number and date of birth', async () => {
    const { user, agent } = await guestWithLicence({ number: 'ZZ999999' });
    await decided(user._id, 'APPROVED', {
      documentType: 'driving_license',
      documentNumberHash: licenceNumberHash('AB123456'),
      documentDobHash: documentDobHash(LICENCE.dob),
    });
    // The licence on the ID, entered now: confirmed by the check.
    expect((await save(agent)).body.licence.status).toBe('APPROVED');
  });

  it('refuses a date of birth that differs from the one the verified ID showed', async () => {
    const { user, agent } = await guestWithLicence();
    await decided(user._id, 'APPROVED', { documentDobHash: documentDobHash(LICENCE.dob) });

    const refused = await save(agent, { dob: '1985-04-21' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'DOB_LOCKED',
      fields: { dob: expect.stringMatching(/ask us to correct it/) },
    });
    const kept = await UserModel.findById(user._id).lean();
    expect(nzDate(kept!.dob!)).toBe(LICENCE.dob);
    expect(await licenceStatus(user._id)).toBe('APPROVED');

    // The date the ID showed is fine, as is the rest of the licence changing.
    const renewed = await save(agent, { expiry: '2036-05-01' });
    expect(renewed.status).toBe(200);
    expect(renewed.body.licence.status).toBe('PENDING');
  });

  it('lets the date of birth change while support is still reviewing the identity check', async () => {
    const { user, agent } = await guestWithLicence();
    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          identityVerification: { status: 'PENDING', documentDobHash: documentDobHash('1991-04-21') },
        },
      },
    );
    // Corrected to match the ID: the staff queue sees that it now matches.
    expect((await save(agent, { dob: '1991-04-21' })).status).toBe(200);
    expect((await UserModel.findById(user._id).lean())!.identityVerification).toMatchObject({
      documentDobMatched: true,
    });
  });
});

describe('the ID check and support’s decision on a licence', () => {
  const client = stripe();
  let session: Partial<Stripe.Identity.VerificationSession> = {};

  beforeEach(() => {
    session = { id: 'vs_1', status: 'requires_input', url: 'https://verify.stripe.com/start/abc' };
    vi.spyOn(client.identity.verificationSessions, 'create').mockImplementation(
      async () => session as Stripe.Response<Stripe.Identity.VerificationSession>,
    );
    vi.spyOn(client.identity.verificationSessions, 'retrieve').mockImplementation(
      async () => session as Stripe.Response<Stripe.Identity.VerificationSession>,
    );
    vi.spyOn(client.identity.verificationReports, 'retrieve').mockImplementation(
      async () =>
        ({
          id: 'vr_1',
          document: {
            type: 'driving_license',
            number: LICENCE.number,
            dob: { year: 1990, month: 4, day: 21 },
          },
        }) as unknown as Stripe.Response<Stripe.Identity.VerificationReport>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('confirms a licence waiting for a check, but never one support turned down', async () => {
    const { user, agent } = await guestWithLicence();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'driverLicence.status': 'REJECTED' } });
    await agent.post('/api/v1/me/verification').send({});

    session = { ...session, status: 'verified', last_verification_report: 'vr_1' };
    await syncIdentity(user.id);
    const checked = await UserModel.findById(user._id).lean();
    expect(checked!.identityVerification!.status).toBe('APPROVED');
    expect(checked!.driverLicence!.status).toBe('REJECTED');
    expect(
      await NotificationModel.findOne({ userId: user._id, type: 'IDENTITY_APPROVED', channel: 'IN_APP' }),
    ).toMatchObject({ payload: { body: expect.stringMatching(/licence still needs sorting out/) } });
  });

  it('confirms a licence that was waiting', async () => {
    const { user, agent } = await guestWithLicence();
    await agent.post('/api/v1/me/verification').send({});
    session = { ...session, status: 'verified', last_verification_report: 'vr_1' };
    await syncIdentity(user.id);
    expect(await licenceStatus(user._id)).toBe('APPROVED');
  });
});
