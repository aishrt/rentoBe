import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { forget } from '../src/lib/memo.js';
import { point } from '../src/lib/model-fields.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from '../src/modules/admin/platform-settings.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { DestinationModel } from '../src/modules/cms/destination.model.js';
import { ReviewModel } from '../src/modules/reviews/review.model.js';
import { PlaceModel } from '../src/modules/search/place.model.js';
import { DESTINATIONS } from '../scripts/seed-data/destinations.js';
import { createHost, createVehicle } from './fixtures.js';
import { createStaff, createUser, staffAgent, testApp } from './helpers.js';

/*
 * The website's content in the staff portal (plan §12.6, §1.4): destination pages added, edited and
 * unpublished; the homepage's headline, customer reviews and the footer's links. Admin only.
 */

const app = testApp();

beforeEach(() => forget());

async function airports() {
  await PlaceModel.create(
    [
      ['Kerikeri Airport', 'KKE', 'Northland', 173.9126, -35.2628],
      ['Auckland Airport', 'AKL', 'Auckland', 174.785, -37.008],
    ].map(([name, code, region, lng, lat]) => ({
      type: 'AIRPORT',
      name,
      code,
      region,
      location: point(lng as number, lat as number),
    })),
  );
}

const BAY_OF_ISLANDS = {
  slug: 'bay-of-islands',
  city: 'Bay of Islands',
  maoriName: 'Pēwhairangi',
  region: 'Northland',
  tagline: 'Sheltered bays, dolphins and Waitangi.',
  intro: 'A subtropical coast of 144 islands, with Paihia, Russell and Kerikeri a short drive apart.',
  heroImage: 'https://images.example.com/bay-of-islands.jpg',
  lat: -35.2817,
  lng: 174.0911,
  airports: ['kke', 'KKE'],
  featured: true,
  order: 6,
};

describe('destination pages', () => {
  it('lets the admin add one, and refuses a web address already in use or an unknown airport', async () => {
    await airports();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const support = await staffAgent('sam@example.co.nz');
    expect((await support.post('/api/v1/admin/content/destinations').send(BAY_OF_ISLANDS)).status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    const created = await admin.post('/api/v1/admin/content/destinations').send(BAY_OF_ISLANDS);
    expect(created.status).toBe(201);
    expect(created.body.destination).toEqual({
      slug: 'bay-of-islands',
      city: 'Bay of Islands',
      maoriName: 'Pēwhairangi',
      region: 'Northland',
      tagline: 'Sheltered bays, dolphins and Waitangi.',
      intro: BAY_OF_ISLANDS.intro,
      heroImage: 'https://images.example.com/bay-of-islands.jpg',
      lat: -35.2817,
      lng: 174.0911,
      airports: ['KKE'],
      featured: true,
      order: 6,
      published: true,
    });

    // On the website at once: the list, its page and the homepage tiles.
    const page = await request(app).get('/api/v1/destinations/bay-of-islands');
    expect(page.body.destination).toMatchObject({
      city: 'Bay of Islands',
      airports: ['KKE'],
      featured: true,
    });

    const again = await admin
      .post('/api/v1/admin/content/destinations')
      .send({ ...BAY_OF_ISLANDS, slug: 'Bay-of-Islands' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SLUG_TAKEN');

    const unknownAirport = await admin
      .post('/api/v1/admin/content/destinations')
      .send({ ...BAY_OF_ISLANDS, slug: 'paihia', airports: ['XYZ'] });
    expect(unknownAirport.status).toBe(400);
    expect(unknownAirport.body.error.fields.airports).toMatch(/XYZ/);

    const invalid = await admin.post('/api/v1/admin/content/destinations').send({
      ...BAY_OF_ISLANDS,
      slug: 'Bay of Islands!',
      lat: 51.5,
      heroImage: 'javascript:alert(1)',
    });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.error.fields).sort()).toEqual(['heroImage', 'lat', 'slug']);

    const entry = await AuditLogModel.findOne({ action: 'content.destination-created' }).lean();
    expect(entry).toMatchObject({ entity: 'destination', entityId: 'bay-of-islands' });
  });

  it('lets the admin edit every field, remove optional ones, and unpublish and publish the page', async () => {
    await airports();
    await DestinationModel.create(DESTINATIONS);
    await createStaff();
    const admin = await staffAgent();

    const edited = await admin.patch('/api/v1/admin/content/destinations/auckland').send({
      city: 'Auckland City',
      maoriName: '',
      region: 'Auckland',
      tagline: '',
      intro: 'The City of Sails, between two harbours and fifty volcanoes.',
      heroImage: '/images/auckland.webp',
      lat: -36.85,
      lng: 174.76,
      airports: ['AKL'],
      featured: false,
      order: 9,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.destination).toEqual({
      slug: 'auckland',
      city: 'Auckland City',
      region: 'Auckland',
      intro: 'The City of Sails, between two harbours and fifty volcanoes.',
      heroImage: '/images/auckland.webp',
      lat: -36.85,
      lng: 174.76,
      airports: ['AKL'],
      featured: false,
      order: 9,
      published: true,
    });

    const halfPlace = await admin.patch('/api/v1/admin/content/destinations/auckland').send({ lat: -36.9 });
    expect(halfPlace.status).toBe(400);
    expect(halfPlace.body.error.fields).toHaveProperty('lng');

    const offSite = await admin
      .patch('/api/v1/admin/content/destinations/auckland')
      .send({ heroImage: '//evil.example/pic.jpg' });
    expect(offSite.body.error.fields).toHaveProperty('heroImage');

    // Unpublished: off the public list, a 404 page, but still in the staff list.
    const hidden = await admin
      .patch('/api/v1/admin/content/destinations/auckland')
      .send({ published: false });
    expect(hidden.body.destination.published).toBe(false);
    const list = await request(app).get('/api/v1/destinations');
    expect(list.body.destinations.map((destination: { slug: string }) => destination.slug)).not.toContain(
      'auckland',
    );
    expect((await request(app).get('/api/v1/destinations/auckland')).status).toBe(404);
    const staffList = await admin.get('/api/v1/admin/content/destinations');
    expect(
      staffList.body.destinations.find((destination: { slug: string }) => destination.slug === 'auckland'),
    ).toMatchObject({ published: false });

    await admin.patch('/api/v1/admin/content/destinations/auckland').send({ published: true });
    expect((await request(app).get('/api/v1/destinations/auckland')).status).toBe(200);
    expect((await admin.patch('/api/v1/admin/content/destinations/atlantis').send({ order: 1 })).status).toBe(
      404,
    );
  });
});

describe('homepage text and footer links', () => {
  it('lets the admin change the headline and supporting line, the original until then', async () => {
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const support = await staffAgent('sam@example.co.nz');
    expect((await support.get('/api/v1/admin/content/hero')).status).toBe(403);

    await createStaff();
    const admin = await staffAgent();
    const original = await admin.get('/api/v1/admin/content/hero');
    expect(original.body).toEqual({
      hero: {
        headline: 'Rent a car from local owners across New Zealand.',
        subheading:
          'City runabouts, family SUVs and EVs for the long way round, booked in minutes from people who live here.',
      },
      saved: false,
    });

    const tooShort = await admin.put('/api/v1/admin/content/hero').send({ headline: 'Cars', subheading: '' });
    expect(Object.keys(tooShort.body.error.fields).sort()).toEqual(['headline', 'subheading']);

    const hero = {
      headline: '  Drive Aotearoa with a local’s car.  ',
      subheading: 'Booked in minutes, all in NZD.',
    };
    const saved = await admin.put('/api/v1/admin/content/hero').send(hero);
    expect(saved.body).toEqual({
      hero: { headline: 'Drive Aotearoa with a local’s car.', subheading: 'Booked in minutes, all in NZD.' },
      saved: true,
    });
    const shown = await request(app).get('/api/v1/cms/home.hero');
    expect(shown.body.hero.headline).toBe('Drive Aotearoa with a local’s car.');
    expect(await AuditLogModel.countDocuments({ action: 'content.hero-edited' })).toBe(1);
  });

  it('lets the admin change the footer’s links, only to https:// addresses or paths on the website', async () => {
    await createStaff();
    const admin = await staffAgent();
    const original = await admin.get('/api/v1/admin/content/footer');
    expect(original.body.saved).toBe(false);
    expect(original.body.footer.groups).toHaveLength(4);

    const footer = {
      groups: [
        {
          title: 'Support',
          links: [
            { label: 'Help centre', href: '/help' },
            { label: 'Roadside help', href: 'https://aa.co.nz/roadservice' },
          ],
        },
      ],
      socialLinks: [{ label: 'Instagram', href: 'https://instagram.com/rentovroom' }],
    };
    const unsafe = await admin.put('/api/v1/admin/content/footer').send({
      groups: [
        {
          title: 'Support',
          links: [
            { label: 'Script', href: 'javascript:alert(1)' },
            { label: 'Elsewhere', href: '//evil.example' },
            { label: 'Sneaky', href: '/\\evil.example' },
            { label: 'Plain', href: 'http://example.com' },
          ],
        },
      ],
      socialLinks: [{ label: 'Facebook', href: '/facebook' }],
    });
    expect(unsafe.status).toBe(400);
    expect(Object.keys(unsafe.body.error.fields).sort()).toEqual([
      'groups.0.links.0.href',
      'groups.0.links.1.href',
      'groups.0.links.2.href',
      'groups.0.links.3.href',
      'socialLinks.0.href',
    ]);

    const saved = await admin.put('/api/v1/admin/content/footer').send(footer);
    expect(saved.body).toEqual({ footer, saved: true });
    const shown = await request(app).get('/api/v1/cms/site.footer');
    expect(shown.body.footer).toEqual(footer);
  });
});

describe('customer reviews on the homepage', () => {
  it('lets the admin pick published reviews, in order, and says how many are needed to show them', async () => {
    const host = await createHost();
    const guest = await createUser({ firstName: 'Kiri' });
    const vehicle = await createVehicle(host._id);
    const review = (body: string, overrides: object = {}) => ({
      bookingId: new mongoose.Types.ObjectId(),
      vehicleId: vehicle._id,
      authorId: guest._id,
      subjectId: host._id,
      direction: 'GUEST_TO_HOST',
      overall: 5,
      body,
      status: 'PUBLISHED',
      ...overrides,
    });
    const [great, lovely, held] = await ReviewModel.create([
      review('Great car, spotless.'),
      review('Lovely Host, easy pick-up.'),
      review('Held for a moderator.', { status: 'AWAITING_REVEAL', moderation: { state: 'HELD' } }),
    ]);
    await PlatformSettingsModel.create({
      _id: PLATFORM_SETTINGS_ID,
      settings: { reviews: { homepageThreshold: 2 } },
    });
    await createStaff();
    const admin = await staffAgent();

    const choices = await admin.get('/api/v1/admin/content/reviews').query({ q: 'spotless' });
    expect(choices.body.reviews).toEqual([
      expect.objectContaining({
        id: great!.id,
        authorName: 'Kiri',
        vehicleTitle: '2021 Toyota Corolla',
        shown: true,
      }),
    ]);

    const refused = await admin
      .put('/api/v1/admin/content/featured-reviews')
      .send({ reviewIds: [great!.id, held!.id] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('UNKNOWN_REVIEW');

    const saved = await admin
      .put('/api/v1/admin/content/featured-reviews')
      .send({ reviewIds: [lovely!.id, great!.id] });
    expect(saved.body).toMatchObject({
      reviewIds: [lovely!.id, great!.id],
      homepageThreshold: 2,
      publishedCount: 2,
    });
    expect(saved.body.reviews.map((choice: { body: string }) => choice.body)).toEqual([
      'Lovely Host, easy pick-up.',
      'Great car, spotless.',
    ]);
    const shown = await request(app).get('/api/v1/reviews/featured');
    expect(shown.body.reviews.map((card: { id: string }) => card.id)).toEqual([lovely!.id, great!.id]);

    // Hidden later: still listed for the admin, marked as not shown.
    await ReviewModel.updateOne(
      { _id: lovely!._id },
      { $set: { status: 'HIDDEN', 'moderation.state': 'HIDDEN' } },
    );
    const picked = await admin.get('/api/v1/admin/content/featured-reviews');
    expect(picked.body.reviews.map((choice: { shown: boolean }) => choice.shown)).toEqual([false, true]);
    expect(picked.body.publishedCount).toBe(1);
  });
});
