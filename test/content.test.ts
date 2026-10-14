import mongoose from 'mongoose';
import { UserModel } from '../src/modules/users/user.model.js';
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

  it('leaves unpublished destinations off the list and their pages, and says which are homepage tiles', async () => {
    await DestinationModel.create([
      ...DESTINATIONS.filter((destination) => destination.slug !== 'rotorua'),
      { ...DESTINATIONS.find((destination) => destination.slug === 'rotorua')!, published: false },
    ]);
    // Saved before `published` existed: still published.
    await DestinationModel.collection.updateOne({ slug: 'auckland' }, { $unset: { published: '' } });

    const list = await request(app).get('/api/v1/destinations');
    expect(list.body.destinations.map((destination: { slug: string }) => destination.slug)).toEqual([
      'queenstown',
      'auckland',
      'christchurch',
      'wellington',
    ]);
    expect(list.body.destinations[0]).toMatchObject({ slug: 'queenstown', featured: true });
    expect((await request(app).get('/api/v1/destinations/rotorua')).status).toBe(404);
    expect((await request(app).get('/api/v1/destinations/auckland')).status).toBe(200);
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
    expect((await request(app).get('/api/v1/cms/home.featured-reviews')).status).toBe(404);
  });

  it('serves the homepage text and footer links, the original ones until an admin saves their own', async () => {
    const hero = await request(app).get('/api/v1/cms/home.hero');
    expect(hero.body.hero.headline).toBe('Rent a car from local owners across New Zealand.');
    expect(hero.headers['cache-control']).toBe('public, max-age=60');
    const footer = await request(app).get('/api/v1/cms/site.footer');
    expect(footer.body.footer.socialLinks).toEqual([]);
    expect(footer.body.footer.groups.map((group: { title: string }) => group.title)).toEqual([
      'Rent',
      'Host',
      'Support',
      'Legal',
    ]);
    expect(footer.body.footer.groups[2].links[0]).toEqual({ label: 'Help centre', href: '/help' });

    await CmsBlockModel.create([
      {
        key: 'home.hero',
        version: '1',
        content: {
          headline: 'Drive Aotearoa with a local’s car.',
          subheading: 'Booked in minutes from locals.',
        },
      },
      // A broken block never breaks the page: the original links stay.
      { key: 'site.footer', version: '1', content: { groups: 'nope' } },
    ]);
    forget();
    expect((await request(app).get('/api/v1/cms/home.hero')).body.hero).toEqual({
      headline: 'Drive Aotearoa with a local’s car.',
      subheading: 'Booked in minutes from locals.',
    });
    expect((await request(app).get('/api/v1/cms/site.footer')).body.footer.groups).toHaveLength(4);
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

  it('shows the reviews an admin picked, in their order, leaving out any hidden since', async () => {
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
    const [great, fine] = await ReviewModel.create([
      review('Great car.'),
      review('Fine, a little late.', 3),
      review('Lovely Host.'),
    ]);
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { reviews: { homepageThreshold: 2 } },
    });
    await CmsBlockModel.create({
      key: 'home.featured-reviews',
      version: '1',
      content: { reviewIds: [fine!.id, great!.id] },
    });
    const bodies = async () => {
      forget();
      const response = await request(app).get('/api/v1/reviews/featured');
      return response.body.show
        ? response.body.reviews.map((shown: { body: string }) => shown.body)
        : 'hidden';
    };
    // Picked by an admin, a 3-star review shows too.
    expect(await bodies()).toEqual(['Fine, a little late.', 'Great car.']);

    await ReviewModel.updateOne(
      { _id: fine!._id },
      { $set: { 'moderation.state': 'HIDDEN', status: 'HIDDEN' } },
    );
    expect(await bodies()).toEqual(['Great car.']);

    // None of the picks can show: the homepage chooses again, from the published reviews.
    await ReviewModel.updateOne(
      { _id: great!._id },
      { $set: { 'moderation.state': 'HIDDEN', status: 'HIDDEN' } },
    );
    await ReviewModel.create(review('Spotless.'));
    expect(await bodies()).toEqual(['Spotless.', 'Lovely Host.']);

    // Below the threshold, the section stays hidden whatever was picked.
    await PlatformSettingsModel.updateOne(
      { _id: PLATFORM_SETTINGS_ID },
      { $set: { 'settings.reviews.homepageThreshold': 10 } },
    );
    expect(await bodies()).toBe('hidden');
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

describe('Saved cars and the last search', () => {
  it('saves, lists and removes favourites, and remembers the last search', async () => {
    const host = await createHost();
    const car = await createVehicle(host._id);
    const draft = await createVehicle(host._id, { status: 'DRAFT' });
    const user = await createUser();
    const agent = browserAgent();
    await agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'correct horse battery staple' });

    expect((await agent.put(`/api/v1/me/favourites/${car.id}`)).status).toBe(204);
    expect((await agent.put(`/api/v1/me/favourites/${car.id}`)).status).toBe(204);
    expect((await agent.put(`/api/v1/me/favourites/${draft.id}`)).status).toBe(404);
    expect((await agent.get('/api/v1/me/favourites')).body).toEqual({ vehicleIds: [car.id] });
    expect((await agent.delete(`/api/v1/me/favourites/${car.id}`)).status).toBe(204);
    expect((await agent.get('/api/v1/me/favourites')).body).toEqual({ vehicleIds: [] });

    const saved = await agent.put('/api/v1/me/last-search').send({
      place: 'Auckland',
      lat: -36.85,
      lng: 174.76,
      start: '2026-12-01T10:00',
      end: '2026-12-04T10:00',
    });
    expect(saved.status).toBe(204);
    const { UserModel } = await import('../src/modules/users/user.model.js');
    const stored = await UserModel.findById(user._id).lean();
    expect(stored!.lastSearch).toMatchObject({ place: 'Auckland', lat: -36.85, lng: 174.76 });
    expect(stored!.lastSearch!.startAt!.toISOString()).toBe('2026-11-30T21:00:00.000Z');

    expect((await request(app).get('/api/v1/me/favourites')).status).toBe(401);
  });
});

describe('Saved cars for older accounts', () => {
  it('lists none for an account written without the list', async () => {
    const user = await createUser();
    await UserModel.collection.updateOne({ _id: user._id }, { $unset: { favouriteVehicleIds: '' } });
    const agent = browserAgent();
    await agent
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'correct horse battery staple' });
    expect((await agent.get('/api/v1/me/favourites')).body).toEqual({ vehicleIds: [] });
  });
});
