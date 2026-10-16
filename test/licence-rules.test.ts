import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripe } from '../src/integrations/stripe.js';
import { formatNzDateTime } from '../src/lib/format.js';
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
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { createBookingRecord, createHost, createVehicle, nzDay } from './fixtures.js';
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
  it('records when the details last changed, keeping it when they’re saved unchanged', async () => {
    const { user, agent } = await guestWithLicence();
    const changedAt = async () =>
      (await UserModel.findById(user._id).lean())!.driverLicence!.detailsChangedAt;
    const first = await changedAt();
    expect(first).toBeInstanceOf(Date);
    expect((await save(agent)).status).toBe(200);
    expect(await changedAt()).toEqual(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await save(agent, { expiry: '2036-05-01' })).status).toBe(200);
    expect((await changedAt())!.getTime()).toBeGreaterThan(first!.getTime());
  });

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

const DAY_MS = 24 * 60 * 60 * 1000;
/** The NZ calendar date a number of days from now, as 2026-10-14. */
const nzToday = (days = 0) => nzDate(new Date(Date.now() + days * DAY_MS));
const yearsBefore = (date: string, years: number) => `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;
const codes = (body: { problems: { code: string }[] }) => body.problems.map((problem) => problem.code);

describe('dates on NZ calendars', () => {
  it('keeps a licence valid through its expiry day', async () => {
    const { agent } = await guestWithLicence({ expiry: nzToday() });
    // A trip ending this evening is fine; one ending tomorrow isn't.
    const tonight = await agent.get('/api/v1/me/checkout').query({ end: nzDay(0, '23:30') });
    expect(codes(tonight.body)).not.toContain('LICENCE_EXPIRES');
    const tomorrow = await agent.get('/api/v1/me/checkout').query({ end: nzDay(1, '09:00') });
    expect(codes(tomorrow.body)).toContain('LICENCE_EXPIRES');
    // Yesterday's has expired.
    const expired = await save(agent, { expiry: nzToday(-1) });
    expect(expired.status).toBe(400);
    expect(expired.body.error.fields).toEqual({ expiry: 'This licence has expired' });
  });

  it('counts age and years licensed to the trip’s start, by calendar date', async () => {
    // They turn 21 in five days, and will have held their licence a year by then.
    const birthday = nzToday(5);
    const { agent } = await guestWithLicence({
      dob: yearsBefore(birthday, 21),
      issuedAt: yearsBefore(birthday, 1),
    });
    const today = await agent.get('/api/v1/me/checkout');
    expect(codes(today.body)).toEqual(expect.arrayContaining(['TOO_YOUNG', 'NOT_LICENSED_LONG_ENOUGH']));
    // A trip starting on the birthday: old enough, and licensed long enough.
    const onTheDay = await agent
      .get('/api/v1/me/checkout')
      .query({ start: nzDay(5, '00:30'), end: nzDay(8) });
    expect(codes(onTheDay.body)).not.toContain('TOO_YOUNG');
    expect(codes(onTheDay.body)).not.toContain('NOT_LICENSED_LONG_ENOUGH');
    const dayBefore = await agent
      .get('/api/v1/me/checkout')
      .query({ start: nzDay(4, '23:30'), end: nzDay(8) });
    expect(codes(dayBefore.body)).toContain('TOO_YOUNG');
  });
});

describe('the country of an overseas licence', () => {
  const overseas = (country: string) =>
    ({ number: 'D1234567', class: 'OVERSEAS', version: undefined, country }) as Partial<typeof LICENCE>;

  it('is kept as its ISO code, from a code or a name', async () => {
    const { user, agent } = await guestWithLicence();
    const usa = await save(agent, overseas('USA'));
    expect(usa.status).toBe(200);
    expect(usa.body.licence.country).toBe('US');
    expect((await UserModel.findById(user._id).lean())!.driverLicence!.country).toBe('US');
    expect((await save(agent, overseas('GB'))).body.licence.country).toBe('GB');
    expect((await save(agent, overseas('England'))).body.licence.country).toBe('GB');

    for (const country of ['Narnia', 'NZ']) {
      const refused = await save(agent, overseas(country));
      expect(refused.status).toBe(400);
      expect(refused.body.error.fields).toEqual({ country: 'Choose the country that issued your licence' });
    }

    // Staff read the country's name.
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    expect((await staff.get(`/api/v1/admin/users/${user.id}`)).body.user.licence.country).toBe(
      'United Kingdom',
    );
  });

  it('reads a country saved as text as its code, so the same details keep their review', async () => {
    const { user, agent } = await guestWithLicence();
    await decided(user._id, 'APPROVED');
    await UserModel.updateOne({ _id: user._id }, { $set: { 'driverLicence.country': 'New Zealand' } });
    const same = await save(agent);
    expect(same.body.licence).toMatchObject({ country: 'NZ', status: 'APPROVED' });
  });
});

describe('a licence changed after booking', () => {
  /** A Guest with an approved licence and identity, a request waiting for its Host and a confirmed trip. */
  async function bookedGuest() {
    const { user, agent } = await guestWithLicence();
    await decided(user._id, 'APPROVED');
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const parties = { guestId: user._id, hostId: host._id, vehicleId: vehicle._id };
    const request = await createBookingRecord(parties, {
      status: 'PENDING',
      instantBook: false,
      startAt: new Date(Date.now() + 10 * DAY_MS),
      endAt: new Date(Date.now() + 13 * DAY_MS),
      requestExpiresAt: new Date(Date.now() + DAY_MS),
    });
    const confirmed = await createBookingRecord(parties, {
      startAt: new Date(Date.now() + 20 * DAY_MS),
      endAt: new Date(Date.now() + 22 * DAY_MS),
    });
    await createStaff('aroha@example.co.nz', 'ADMIN');
    return { user, agent, request, confirmed, staff: await staffAgent() };
  }

  const alerts = (ref: string) =>
    NotificationModel.countDocuments({
      type: 'LICENCE_NOT_ELIGIBLE',
      channel: 'IN_APP',
      'payload.link': `/admin/bookings/${ref}`,
    });

  it('holds a request for support and flags a confirmed trip when the licence no longer covers it', async () => {
    const { agent, request, confirmed, staff, user } = await bookedGuest();
    // Renewed details that run out before either trip ends.
    expect((await save(agent, { expiry: nzToday(11) })).status).toBe(200);
    expect(await BookingModel.findById(request._id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'PENDING' },
    });
    expect((await BookingModel.findById(confirmed._id).lean())!.status).toBe('CONFIRMED');
    expect(await alerts(request.ref)).toBe(1);
    expect(await alerts(confirmed.ref)).toBe(1);
    // The same details saved again don't alert again.
    await save(agent, { expiry: nzToday(11) });
    expect(await alerts(request.ref)).toBe(1);

    // Support approve the details, but they still don't cover the trip: the request keeps waiting.
    const approved = await staff
      .post(`/api/v1/admin/users/${user.id}/licence-review`)
      .send({ decision: 'APPROVE' });
    expect(approved.body).toMatchObject({ licenceStatus: 'APPROVED', licenceNotEligible: [request.ref] });
    expect((await BookingModel.findById(request._id).lean())!.verificationReview!.status).toBe('PENDING');

    // New details still too short for the confirmed trip (flagged again), then turned down: the request is
    // released, and the confirmed trip is flagged once more.
    await save(agent, { expiry: nzToday(12) });
    const rejected = await staff
      .post(`/api/v1/admin/users/${user.id}/licence-review`)
      .send({ decision: 'REJECT', note: 'The card is a copy.' });
    expect(rejected.body.released).toEqual([request.ref]);
    expect((await BookingModel.findById(request._id).lean())!.status).toBe('EXPIRED');
    expect(await alerts(confirmed.ref)).toBe(3);
    const email = await NotificationModel.findOne({
      userId: user._id,
      type: 'LICENCE_REJECTED',
      channel: 'EMAIL',
    }).lean();
    expect(JSON.stringify(email!.payload)).toContain(`Your confirmed booking ${confirmed.ref} can’t start`);
  });

  it('releases every request when support turn the licence down, not only those waiting for them', async () => {
    const { request, user, staff } = await bookedGuest();
    // The licence went back to support without the request being held for it (saved before requests were).
    await UserModel.updateOne({ _id: user._id }, { $set: { 'driverLicence.status': 'PENDING' } });
    expect((await BookingModel.findById(request._id).lean())!.verificationReview).toBeUndefined();
    const rejected = await staff
      .post(`/api/v1/admin/users/${user.id}/licence-review`)
      .send({ decision: 'REJECT' });
    expect(rejected.body.released).toEqual([request.ref]);
    expect((await BookingModel.findById(request._id).lean())!.status).toBe('EXPIRED');
  });

  it('lets a held request go ahead once the licence is fixed and approved', async () => {
    const { agent, request, user } = await bookedGuest();
    await save(agent, { expiry: nzToday(11) });
    expect((await BookingModel.findById(request._id).lean())!.verificationReview!.status).toBe('PENDING');
    // Fixed with details the passed ID check confirms: the request goes back to its Host.
    await decided(user._id, 'APPROVED', {
      documentType: 'driving_license',
      documentNumberHash: licenceNumberHash(LICENCE.number),
      documentDobHash: documentDobHash(LICENCE.dob),
      documentDobMatched: true,
    });
    const fixed = await save(agent, { expiry: '2036-05-01' });
    expect(fixed.body.licence.status).toBe('APPROVED');
    expect(await BookingModel.findById(request._id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'APPROVED' },
    });
  });

  it('holds both trips while changed details wait for support, and lists them with the licence', async () => {
    const { agent, request, confirmed, staff, user } = await bookedGuest();
    const count = (type: string) => NotificationModel.countDocuments({ type, channel: 'IN_APP' });
    // Renewed details that still cover both trips, but no ID confirmed them: support checks them first.
    expect((await save(agent, { expiry: '2035-05-01' })).status).toBe(200);
    expect(await BookingModel.findById(request._id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'PENDING' },
    });
    expect((await BookingModel.findById(confirmed._id).lean())!.status).toBe('CONFIRMED');
    // Support hear of each: the request with when it expires, the trip with when it starts.
    const held = await NotificationModel.findOne({ type: 'VERIFICATION_BOOKING_WAITING', channel: 'IN_APP' });
    expect(JSON.stringify(held!.payload)).toContain(request.ref);
    const trip = await NotificationModel.findOne({ type: 'LICENCE_CHECK_BEFORE_TRIP', channel: 'IN_APP' });
    expect(JSON.stringify(trip!.payload)).toContain(formatNzDateTime(confirmed.startAt));
    // The same details saved again don't alert again.
    await save(agent, { expiry: '2035-05-01' });
    expect(await count('VERIFICATION_BOOKING_WAITING')).toBe(1);
    expect(await count('LICENCE_CHECK_BEFORE_TRIP')).toBe(1);

    const queue = await staff.get('/api/v1/admin/verifications');
    expect(queue.body.items).toEqual([
      expect.objectContaining({
        userId: user.id,
        kind: 'LICENCE',
        waitingBookings: [
          {
            ref: request.ref,
            vehicleTitle: '2021 Toyota Corolla',
            expiresAt: request.requestExpiresAt!.toISOString(),
          },
          {
            ref: confirmed.ref,
            vehicleTitle: '2021 Toyota Corolla',
            startsAt: confirmed.startAt.toISOString(),
          },
        ],
      }),
    ]);

    // Approved: the request goes back to its Host, who hasn't answered yet.
    const approved = await staff
      .post(`/api/v1/admin/users/${user.id}/licence-review`)
      .send({ decision: 'APPROVE' });
    expect(approved.body).toMatchObject({
      licenceStatus: 'APPROVED',
      confirmed: [],
      waitingForHost: [request.ref],
    });
  });

  it('makes the Host’s acceptance wait when the Guest’s licence went back to support after they booked', async () => {
    const { request, user } = await bookedGuest();
    // Sent back to support without the request being held for it (saved before requests were).
    await UserModel.updateOne({ _id: user._id }, { $set: { 'driverLicence.status': 'PENDING' } });
    const hostAgent = browserAgent();
    await hostAgent.post('/api/v1/auth/login').send({ email: 'hana@example.co.nz', password: PASSWORD });

    // Recorded, not charged (nothing was authorised here, so a capture would have been refused).
    const accepted = await hostAgent.post(`/api/v1/bookings/${request.ref}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.booking).toMatchObject({
      status: 'PENDING',
      verificationReview: 'PENDING',
      hostAccepted: true,
    });
    expect(await BookingModel.findById(request._id).lean()).toMatchObject({
      status: 'PENDING',
      verificationReview: { status: 'PENDING' },
      hostAcceptedAt: expect.any(Date),
    });
  });
});
