import type Stripe from 'stripe';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { forget } from '../src/lib/memo.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { AvailabilityBlockModel } from '../src/modules/availability/availability-block.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { applyAccountState } from '../src/modules/payouts/connect.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { createPlaces, createVehicle, nzDay } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

const app = testApp();

type Agent = ReturnType<typeof browserAgent>;

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.4 test');

async function signIn(email: string): Promise<Agent> {
  const agent = browserAgent();
  const response = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return agent;
}

async function applicant(email = 'hana@example.co.nz', phone = '+64211234567') {
  const user = await createUser({ email, firstName: 'Hana' });
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { phone, phoneVerifiedAt: new Date(), emailVerifiedAt: new Date() } },
  );
  return { user, agent: await signIn(email) };
}

/** Uploads a file the way the website does: a signed target, then the upload itself. */
async function upload(
  agent: Agent,
  vehicleId: string,
  purpose: 'VEHICLE_PHOTO' | 'VEHICLE_DOCUMENT',
  body = PHOTO,
  contentType = 'image/jpeg',
) {
  const target = await agent
    .post('/api/v1/uploads/signature')
    .send({ purpose, vehicleId, contentType, size: body.length });
  expect(target.status).toBe(200);
  expect(target.body).toMatchObject({ driver: 'local', method: 'PUT' });
  const path = new URL(target.body.url).pathname;
  const put = await agent.put(path).set('Content-Type', contentType).send(body);
  expect(put.status).toBe(201);
  expect(put.body.key).toBe(target.body.key);
  return target.body.key as string;
}

const details = {
  regoPlate: 'abc 123',
  vin: 'JTDKB20U093512345',
  make: 'Toyota',
  model: 'Corolla',
  year: 2021,
  variant: 'GX Hybrid',
  bodyType: 'HATCHBACK',
  fuelType: 'HYBRID',
  transmission: 'AUTOMATIC',
  seats: 5,
  doors: 5,
  features: ['Apple CarPlay', 'Reversing camera'],
  onboardingStep: 2,
};

const pickupAddress = {
  streetNumber: '1',
  street: 'Ponsonby Road',
  suburb: 'Ponsonby',
  city: 'Auckland',
  region: 'Auckland',
  postcode: '1011',
  lat: -36.8566,
  lng: 174.7445,
};

beforeEach(() => forget());

describe('Host application', () => {
  it('needs a verified mobile and the Host Agreement', async () => {
    const user = await createUser();
    const agent = await signIn(user.email);
    const refused = await agent.post('/api/v1/me/host-application').send({ acceptHostAgreement: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PHONE_NOT_VERIFIED');

    await UserModel.updateOne(
      { _id: user._id },
      { $set: { phone: '+64211234567', phoneVerifiedAt: new Date() } },
    );
    const noAgreement = await agent.post('/api/v1/me/host-application').send({});
    expect(noAgreement.body.error.fields.acceptHostAgreement).toBe('Please accept the Host Agreement');
    const noGst = await agent
      .post('/api/v1/me/host-application')
      .send({ acceptHostAgreement: true, gstRegistered: true });
    expect(noGst.body.error.fields.gstNumber).toBe('Enter your GST number');

    const applied = await agent.post('/api/v1/me/host-application').send({
      acceptHostAgreement: true,
      bio: 'Auckland local.',
      gstRegistered: true,
      gstNumber: '123456789',
    });
    expect(applied.status).toBe(200);
    expect(applied.body.host).toMatchObject({
      status: 'APPLIED',
      gstNumber: '123-456-789',
      bio: 'Auckland local.',
    });

    const stored = await UserModel.findById(user._id).lean();
    expect(stored!.roles).toEqual(['GUEST', 'HOST']);
    expect(stored!.agreements.map((agreement) => agreement.type)).toContain('HOST');
    expect((await agent.get('/api/v1/me')).body.user.hostStatus).toBe('APPLIED');

    const email = await NotificationModel.findOne({
      channel: 'EMAIL',
      type: 'HOST_APPLICATION_RECEIVED',
    }).lean();
    expect(email!.payload).toMatchObject({
      template: 'hostApplicationReceived',
      props: { firstName: 'Kiri' },
    });
    expect(await JobModel.countDocuments({ type: 'notification.send' })).toBe(1);
    expect(await NotificationModel.countDocuments({ channel: 'IN_APP' })).toBe(1);
  });

  it('approves without the identity check when the identityForHosts setting is off', async () => {
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { verification: { identityForHosts: false } },
    });
    const { user, agent } = await applicant();
    await agent.post('/api/v1/me/host-application').send({ acceptHostAgreement: true });
    expect((await agent.get('/api/v1/me/host-profile')).body.host.identityRequired).toBe(false);

    await createStaff();
    const staff = await staffAgent();
    const [application] = (await staff.get('/api/v1/admin/host-applications')).body.applications;
    expect(application).toMatchObject({ identityStatus: 'NONE', identityRequired: false });
    const approved = await staff.post(`/api/v1/admin/host-applications/${user.id}/approve`).send({});
    expect(approved.body.status).toBe('APPROVED');
  });
});

describe('Vehicle onboarding', () => {
  beforeEach(createPlaces);

  it('takes a car from draft through all six steps to review, approval and search', async () => {
    const { user, agent } = await applicant();
    await agent.post('/api/v1/me/host-application').send({ acceptHostAgreement: true });

    const draft = await agent.post('/api/v1/host/vehicles');
    expect(draft.status).toBe(201);
    const id = draft.body.vehicle.id as string;
    expect(draft.body.vehicle).toMatchObject({
      status: 'DRAFT',
      onboardingStep: 1,
      checklist: { complete: false },
    });

    // Step 1: details.
    const step1 = await agent.patch(`/api/v1/host/vehicles/${id}`).send(details);
    expect(step1.status).toBe(200);
    expect(step1.body.vehicle).toMatchObject({
      regoPlate: 'ABC123',
      title: '2021 Toyota Corolla',
      onboardingStep: 2,
    });
    const tooMany = await agent.patch(`/api/v1/host/vehicles/${id}`).send({ seats: 40 });
    expect(tooMany.body.error.fields.seats).toBe('Seats must be 2–12');

    // Step 2: document dates and files. Documents are private.
    await agent
      .patch(`/api/v1/host/vehicles/${id}`)
      .send({ regoExpiry: '2027-06-30', wofExpiry: '2027-03-31', onboardingStep: 3 });
    for (const type of ['REGO', 'WOF', 'INSURANCE']) {
      const key = await upload(agent, id, 'VEHICLE_DOCUMENT', PDF, 'application/pdf');
      const attached = await agent.post(`/api/v1/host/vehicles/${id}/documents`).send({ type, upload: key });
      expect(attached.status).toBe(201);
    }

    // Submitting now lists what's still missing, by step.
    const early = await agent.post(`/api/v1/host/vehicles/${id}/submit`);
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('LISTING_INCOMPLETE');
    expect(Object.keys(early.body.error.fields)).toEqual(
      expect.arrayContaining([
        'photos.FRONT',
        'photos.TYRES',
        'pricing.dailyCents',
        'deliveryOptions.PICKUP',
      ]),
    );

    // Step 3: the required photo angles, one flagged dark by the browser.
    for (const type of ['FRONT', 'REAR', 'DRIVER', 'PASSENGER', 'INTERIOR', 'DASH', 'BOOT', 'TYRES']) {
      const key = await upload(agent, id, 'VEHICLE_PHOTO');
      const attached = await agent
        .post(`/api/v1/host/vehicles/${id}/photos`)
        .send({ type, upload: key, width: 1600, height: 1200, qualityFlag: type === 'BOOT' ? 'DARK' : 'OK' });
      expect(attached.status).toBe(201);
    }

    // Steps 4–6: pricing, availability rules, pickup and delivery.
    await agent.patch(`/api/v1/host/vehicles/${id}`).send({
      pricing: { dailyCents: 8900, weeklyDiscountPct: 10, monthlyDiscountPct: 20, extraKmCents: 35 },
      kmAllowancePerDay: 250,
      rules: { minDays: 1, maxDays: 30, cancellationTier: 'FLEXIBLE' },
      onboardingStep: 5,
    });
    await agent
      .patch(`/api/v1/host/vehicles/${id}`)
      .send({ rules: { minNoticeHours: 6, bufferHours: 3, instantBook: true } });
    const step6 = await agent.patch(`/api/v1/host/vehicles/${id}`).send({
      deliveryOptions: [
        { type: 'PICKUP', address: pickupAddress, instructions: 'Parked on the street.' },
        { type: 'AIRPORT', airportCode: 'akl', feeCents: 4500, instructions: 'Meet at arrivals.' },
        { type: 'DELIVERY', radiusKm: 15, feeCents: 3000 },
      ],
      onboardingStep: 6,
    });
    expect(step6.status).toBe(200);
    expect(step6.body.vehicle.deliveryOptions.map((option: { label: string }) => option.label)).toEqual([
      'Ponsonby, Auckland',
      'Auckland Airport',
      'Delivery to your address',
    ]);
    expect(step6.body.vehicle).toMatchObject({
      suburb: 'Ponsonby',
      city: 'Auckland',
      checklist: { complete: true },
    });
    expect(step6.body.vehicle.checklist.flags).toEqual([
      expect.objectContaining({ code: 'LOW_QUALITY_PHOTO' }),
    ]);

    const submitted = await agent.post(`/api/v1/host/vehicles/${id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.vehicle).toMatchObject({
      status: 'UNDER_REVIEW',
      slug: '2021-toyota-corolla-auckland',
    });

    // Staff: the listing can't go live before the Host is approved.
    await createStaff();
    const staff = await staffAgent();
    const queue = await staff.get('/api/v1/admin/vehicles');
    expect(queue.body.vehicles).toEqual([expect.objectContaining({ id, status: 'UNDER_REVIEW', flags: 1 })]);
    const review = await staff.get(`/api/v1/admin/vehicles/${id}`);
    expect(review.body.host).toMatchObject({ name: 'Hana Tester', status: 'APPLIED', payoutsEnabled: false });
    // Staff open documents through short-lived links.
    const link = new URL(review.body.vehicle.documents[0].link);
    expect((await staff.get(`${link.pathname}${link.search}`)).status).toBe(200);

    const tooSoon = await staff.post(`/api/v1/admin/vehicles/${id}/approve`).send({});
    expect(tooSoon.body.error.code).toBe('HOST_NOT_APPROVED');

    const applications = await staff.get('/api/v1/admin/host-applications');
    expect(applications.body.applications).toEqual([
      expect.objectContaining({
        userId: user.id,
        emailVerified: true,
        phoneVerified: true,
        identityStatus: 'NONE',
        identityRequired: true,
        vehicles: { total: 1, underReview: 1 },
      }),
    ]);
    // Hosts pass the identity check before they're approved (the identityForHosts setting, spec §22).
    const unverified = await staff.post(`/api/v1/admin/host-applications/${user.id}/approve`).send({});
    expect(unverified.status).toBe(409);
    expect(unverified.body.error.code).toBe('IDENTITY_NOT_VERIFIED');
    expect((await agent.get('/api/v1/me/host-profile')).body.host).toMatchObject({
      status: 'APPLIED',
      identityRequired: true,
    });
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { identityVerification: { status: 'APPROVED', verifiedAt: new Date() } } },
    );
    expect(
      (await staff.post(`/api/v1/admin/host-applications/${user.id}/approve`).send({})).body.status,
    ).toBe('APPROVED');

    const approved = await staff.post(`/api/v1/admin/vehicles/${id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.vehicle).toMatchObject({ status: 'ACTIVE', waitingForPayouts: true });
    expect(
      approved.body.vehicle.photos.every((photo: { status: string }) => photo.status === 'APPROVED'),
    ).toBe(true);
    expect(
      approved.body.vehicle.documents.every((document: { status: string }) => document.status === 'VERIFIED'),
    ).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'vehicle.approved' })).toBe(1);
    // Approved, but it waits for the Host's payout setup before going live (plan §8.2), and the email says so.
    const email = await NotificationModel.findOne({ type: 'LISTING_APPROVED', channel: 'EMAIL' }).lean();
    expect(email!.payload).toMatchObject({
      template: 'listingDecision',
      props: {
        decision: 'APPROVED',
        waitingForPayouts: true,
        url: expect.stringMatching(/\/host\/earnings$/),
      },
    });
    expect(await NotificationModel.countDocuments({ type: 'LISTING_APPROVED', channel: 'EMAIL' })).toBe(1);

    expect((await request(app).get('/api/v1/search').query({ where: 'Ponsonby' })).body.results).toEqual([]);
    expect((await agent.get('/api/v1/host/vehicles')).body.vehicles[0].waitingForPayouts).toBe(true);
    await UserModel.updateOne({ _id: user._id }, { $set: { 'hostProfile.stripeAccountId': 'acct_test' } });
    await applyAccountState({
      id: 'acct_test',
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
      requirements: { currently_due: [], past_due: [] },
    } as unknown as Stripe.Account);

    expect((await agent.get(`/api/v1/host/vehicles/${id}`)).body.vehicle.waitingForPayouts).toBe(false);
    // Live: in search, with the approved photos served publicly.
    const search = await request(app).get('/api/v1/search').query({ where: 'Ponsonby' });
    expect(search.body.results.map((card: { id: string }) => card.id)).toEqual([id]);
    const photo = new URL(search.body.results[0].photo.url);
    const served = await request(app).get(photo.pathname);
    expect(served.status).toBe(200);
    expect(served.headers['cross-origin-resource-policy']).toBe('same-site');
    // Documents are never served without a signed link.
    const documentKey = (await VehicleModel.findById(id).lean())!.documents[0]!.url.replace('local:', '');
    expect((await request(app).get(`/api/v1/files/${documentKey}`)).status).toBe(404);
    expect(
      (await request(app).get(`/api/v1/files/private/${documentKey}?e=9999999999&s=forged`)).status,
    ).toBe(403);
  });

  it('applies price changes at once, but sends new key details and photos to review', async () => {
    const { user, agent } = await applicant();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { hostProfile: { status: 'APPROVED', appliedAt: new Date() } } },
    );
    const vehicle = await createVehicle(user._id);

    const price = await agent.patch(`/api/v1/host/vehicles/${vehicle.id}`).send({
      pricing: { dailyCents: 9900, weeklyDiscountPct: 0, monthlyDiscountPct: 0, extraKmCents: 0 },
    });
    expect(price.body.vehicle.status).toBe('ACTIVE');

    const key = await upload(agent, vehicle.id, 'VEHICLE_PHOTO');
    await agent.post(`/api/v1/host/vehicles/${vehicle.id}/photos`).send({ type: 'BOOT', upload: key });
    const listing = await request(app).get(`/api/v1/vehicles/${vehicle.slug}`);
    expect(listing.body.vehicle.pricing.dailyCents).toBe(9900);
    expect(listing.body.vehicle.photos.map((photo: { type: string }) => photo.type)).not.toContain('BOOT');
    const summary = await agent.get('/api/v1/host/vehicles');
    expect(summary.body.vehicles[0]).toMatchObject({ pendingChanges: true, status: 'ACTIVE' });

    const model = await agent.patch(`/api/v1/host/vehicles/${vehicle.id}`).send({ model: 'Yaris' });
    expect(model.body.vehicle.status).toBe('UNDER_REVIEW');
    expect(await AuditLogModel.countDocuments({ action: 'vehicle.key-details-changed' })).toBe(1);
    expect((await request(app).get(`/api/v1/vehicles/${vehicle.slug}`)).status).toBe(404);
  });

  it('keeps a plate on one listing and a draft to its Host', async () => {
    const { user, agent } = await applicant();
    await agent.post('/api/v1/me/host-application').send({ acceptHostAgreement: true });
    await createVehicle(user._id, { regoPlate: 'ABC123' });
    const draft = await agent.post('/api/v1/host/vehicles');
    const taken = await agent
      .patch(`/api/v1/host/vehicles/${draft.body.vehicle.id}`)
      .send({ regoPlate: 'ABC 123' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PLATE_TAKEN');

    const other = await applicant('mere@example.co.nz', '+64217654321');
    expect((await other.agent.get(`/api/v1/host/vehicles/${draft.body.vehicle.id}`)).status).toBe(403);
    const signature = await other.agent.post('/api/v1/uploads/signature').send({
      purpose: 'VEHICLE_PHOTO',
      vehicleId: draft.body.vehicle.id,
      contentType: 'image/jpeg',
      size: 100,
    });
    expect(signature.status).toBe(403);

    const notAHost = await createUser({ email: 'guest@example.co.nz' });
    const guest = await signIn(notAHost.email);
    expect((await guest.post('/api/v1/host/vehicles')).body.error.code).toBe('NOT_A_HOST');

    expect((await agent.delete(`/api/v1/host/vehicles/${draft.body.vehicle.id}`)).status).toBe(204);
  });

  it('manages the calendar: blocks, recurring rules and the staff override', async () => {
    const { user, agent } = await applicant();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { hostProfile: { status: 'APPROVED', appliedAt: new Date() } } },
    );
    const vehicle = await createVehicle(user._id);

    const block = await agent
      .post(`/api/v1/host/vehicles/${vehicle.id}/blocks`)
      .send({ start: nzDay(5).slice(0, 10), end: nzDay(7).slice(0, 10), note: 'Servicing' });
    expect(block.status).toBe(201);
    expect(block.body.block).toMatchObject({ reason: 'HOST_BLOCK', note: 'Servicing' });

    const rules = await agent
      .put(`/api/v1/host/vehicles/${vehicle.id}/recurring-rules`)
      .send({ rules: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: '08:00', endTime: '18:00' }] });
    expect(rules.status).toBe(200);
    expect(rules.body.blocks).toBeGreaterThan(200);

    const calendar = await agent.get(`/api/v1/host/vehicles/${vehicle.id}/calendar`);
    expect(calendar.body.blocks.some((entry: { reason: string }) => entry.reason === 'HOST_BLOCK')).toBe(
      true,
    );
    expect(calendar.body.blocks.some((entry: { reason: string }) => entry.reason === 'RECURRING')).toBe(true);

    expect(
      (await agent.delete(`/api/v1/host/vehicles/${vehicle.id}/blocks/${block.body.block.id}`)).status,
    ).toBe(204);

    await createStaff();
    const staff = await staffAgent();
    const override = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/blocks`)
      .send({ start: nzDay(20), end: nzDay(21) });
    expect(override.body.block.reason).toBe('ADMIN');
    const recurring = await AvailabilityBlockModel.findOne({ vehicleId: vehicle._id, reason: 'RECURRING' });
    expect((await staff.delete(`/api/v1/admin/vehicles/${vehicle.id}/blocks/${recurring!.id}`)).status).toBe(
      204,
    );
    // Hosts can't remove the staff's block.
    expect(
      (await agent.delete(`/api/v1/host/vehicles/${vehicle.id}/blocks/${override.body.block.id}`)).status,
    ).toBe(404);
  });

  it('lets staff reject one photo, which the Host must replace', async () => {
    const { user } = await applicant();
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { hostProfile: { status: 'APPROVED', appliedAt: new Date() } } },
    );
    const vehicle = await createVehicle(user._id);
    await createStaff();
    const staff = await staffAgent();
    const photoId = vehicle.photos[0]!._id!.toString();
    const rejected = await staff
      .post(`/api/v1/admin/vehicles/${vehicle.id}/photos/${photoId}`)
      .send({ decision: 'REJECT' });
    expect(rejected.body.vehicle.photos[0]).toMatchObject({
      status: 'REJECTED',
      qualityFlag: 'ADMIN_FLAGGED',
    });
    expect(await NotificationModel.countDocuments({ type: 'LISTING_PHOTO_REJECTED' })).toBe(1);
  });
});
