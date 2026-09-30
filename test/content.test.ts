import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { forget } from '../src/lib/memo.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { CmsBlockModel } from '../src/modules/cms/cms-block.model.js';
import { DestinationModel } from '../src/modules/cms/destination.model.js';
import { FaqModel } from '../src/modules/help/faq.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { DESTINATIONS } from '../scripts/seed-data/destinations.js';
import { FAQS } from '../scripts/seed-data/faqs.js';
import { LEGAL_PAGES } from '../scripts/seed-data/legal.js';
import { createHost, createVehicle } from './fixtures.js';
import { FRONTEND_ORIGIN, browserAgent, createUser, testApp } from './helpers.js';

const app = testApp();

beforeEach(() => forget());

describe('Public content', () => {
  it('lists destinations and shows one', async () => {
    await DestinationModel.create(DESTINATIONS);
    const list = await request(app).get('/api/v1/destinations');
    expect(list.body.destinations.map((destination: { slug: string }) => destination.slug)).toEqual([
      'queenstown',
      'auckland',
      'christchurch',
      'wellington',
      'rotorua',
    ]);
    expect(list.headers['cache-control']).toBe('public, max-age=60');

    const one = await request(app).get('/api/v1/destinations/Auckland');
    expect(one.body.destination).toMatchObject({
      city: 'Auckland',
      maoriName: 'Tāmaki Makaurau',
      airports: ['AKL'],
    });
    expect(one.body.destination.intro).toContain('two harbours');
    expect((await request(app).get('/api/v1/destinations/atlantis')).status).toBe(404);
  });

  it('serves the legal pages and nothing else from the CMS', async () => {
    await CmsBlockModel.create([
      ...LEGAL_PAGES,
      { key: 'home.featured-vehicles', version: '1', content: { vehicleIds: [] } },
    ]);
    const terms = await request(app).get('/api/v1/cms/legal.terms');
    expect(terms.body.page).toMatchObject({ key: 'legal.terms', title: 'Terms & Conditions' });
    expect(terms.body.page.markdown).toContain('placeholder');
    expect((await request(app).get('/api/v1/cms/home.featured-vehicles')).status).toBe(404);
  });

  it('lists FAQs by audience and for the homepage', async () => {
    await FaqModel.create(FAQS);
    const all = await request(app).get('/api/v1/faqs');
    expect(all.body.faqs).toHaveLength(FAQS.length);
    const home = await request(app).get('/api/v1/faqs').query({ home: 'true' });
    expect(home.body.faqs.map((faq: { question: string }) => faq.question)[0]).toBe(
      'How is Rento Vroom different from a rental company?',
    );
    const hosts = await request(app).get('/api/v1/faqs').query({ audience: 'HOST' });
    expect(hosts.body.faqs.every((faq: { audience: string }) => faq.audience !== 'GUEST')).toBe(true);
  });

  it('publishes the policies public pages show, and nothing staff-only', async () => {
    const response = await request(app).get('/api/v1/policies');
    expect(response.body).toMatchObject({
      fees: { guestServiceFeePct: 10, hostCommissionPct: 20, gstRatePct: 15 },
      cancellation: { defaultTier: 'MODERATE' },
      hostEstimator: { bookedDaysPerMonth: 10, dailyCentsByBodyType: { SUV: 9500 } },
    });
    expect(response.body.protectionPlans).toHaveLength(3);
    expect(response.body.risk).toBeUndefined();
    expect(response.body.retention).toBeUndefined();
  });

  it('shows customer reviews only once there are enough', async () => {
    const host = await createHost();
    const guest = await createUser({ firstName: 'Kiri' });
    const vehicle = await createVehicle(host._id);
    const review = (body: string, overall = 5) => ({
      bookingId: new mongoose.Types.ObjectId(),
      vehicleId: vehicle._id,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      overall,
      body,
      status: 'PUBLISHED',
    });
    await ReviewModel.create([review('Great car.'), review('Fine.', 3)]);
    expect((await request(app).get('/api/v1/reviews/featured')).body).toEqual({ show: false, reviews: [] });

    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { reviews: { homepageThreshold: 2 } },
    });
    forget();
    const shown = await request(app).get('/api/v1/reviews/featured');
    expect(shown.body.show).toBe(true);
    expect(shown.body.reviews).toEqual([
      expect.objectContaining({
        body: 'Great car.',
        author: { firstName: 'Kiri' },
        vehicleTitle: '2021 Toyota Corolla',
        city: 'Auckland',
      }),
    ]);
  });
});

describe('Contact form', () => {
  const message = {
    name: 'Kiri Tester',
    email: 'kiri@example.co.nz',
    category: 'BOOKING',
    subject: 'Changing my pick-up time',
    message: 'Can I pick the car up an hour later than booked?',
  };

  it('creates a ticket signed out, and emails its reference', async () => {
    const response = await request(app)
      .post('/api/v1/support/tickets')
      .set('Origin', FRONTEND_ORIGIN)
      .send(message);
    expect(response.status).toBe(201);
    expect(response.body.ref).toMatch(/^ST-[A-Z0-9]{6}$/);

    const ticket = await SupportTicketModel.findOne({ ref: response.body.ref }).lean();
    expect(ticket).toMatchObject({
      name: 'Kiri Tester',
      email: 'kiri@example.co.nz',
      category: 'BOOKING',
      status: 'OPEN',
    });
    expect(ticket!.userId).toBeUndefined();
    expect(ticket!.messages[0]!.body).toBe(message.message);

    const job = await JobModel.findOne({ type: 'email.send' }).lean();
    expect(job!.payload).toMatchObject({
      to: 'kiri@example.co.nz',
      template: 'supportTicketReceived',
      props: { name: 'Kiri', ref: response.body.ref },
    });
  });

  it('links a signed-in user’s ticket to their account', async () => {
    const user = await createUser();
    const agent = browserAgent();
    await agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'correct horse battery staple' });
    const response = await agent
      .post('/api/v1/support/tickets')
      .send({ ...message, bookingRef: 'rv-abc234' });
    expect(response.status).toBe(201);
    const ticket = await SupportTicketModel.findOne({ ref: response.body.ref }).lean();
    expect(ticket!.userId?.toString()).toBe(user.id);
    // Not one of their bookings, so the reference is kept in the message instead.
    expect(ticket!.messages[0]!.body).toContain('Booking reference: RV-ABC234');
  });

  it('checks the fields', async () => {
    const response = await request(app)
      .post('/api/v1/support/tickets')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ ...message, email: 'nope', message: 'hi' });
    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.fields).sort()).toEqual(['email', 'message']);
  });
});
