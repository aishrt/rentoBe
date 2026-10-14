import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { point } from '../src/lib/model-fields.js';
import { formatNzdFromCents } from '../src/lib/format.js';
import { DestinationModel } from '../src/modules/cms/destination.model.js';
import { VehicleModel } from '../src/modules/vehicles/vehicle.model.js';
import { clearWebsiteCache, type SeoManifest } from '../src/pages/frontend-shell.js';
import { testApp } from './helpers.js';

const SHELL = `<!doctype html>
<html lang="en-NZ">
  <head>
    <!-- seo:start -->
    <title>Rento Vroom</title>
    <!-- seo:end -->
    <script type="module" src="/assets/index-abc123.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

let website: { shell: string | null; manifest: SeoManifest | null };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearWebsiteCache();
  website = {
    shell: SHELL,
    manifest: { indexablePaths: ['/', '/how-it-works'], vehiclePages: true, destinationPages: true },
  };
  // The website (FRONTEND_URL) as the backend sees it.
  fetchMock = vi.fn(async (url: URL) => {
    const body =
      url.pathname === '/index.html'
        ? website.shell
        : url.pathname === '/seo-manifest.json'
          ? website.manifest && JSON.stringify(website.manifest)
          : null;
    return body === null ? new Response('Not found', { status: 404 }) : new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function corolla(overrides: Record<string, unknown> = {}) {
  return VehicleModel.create({
    hostId: '64b000000000000000000001',
    slug: '2021-toyota-corolla-auckland',
    regoPlate: 'ABC123',
    make: 'Toyota',
    model: 'Corolla',
    year: 2021,
    variant: 'GX Hybrid',
    fuelType: 'HYBRID',
    transmission: 'AUTOMATIC',
    seats: 5,
    status: 'ACTIVE',
    suburb: 'Ponsonby',
    city: 'Auckland',
    region: 'Auckland',
    location: point(174.744, -36.856),
    pricing: { dailyCents: 5900, weeklyDiscountPct: 10, monthlyDiscountPct: 20, extraKmCents: 35 },
    rating: { avg: 4.5, count: 2 },
    photos: [
      { type: 'REAR', url: 'https://img.example/rear.webp', order: 1, status: 'APPROVED' },
      { type: 'FRONT', url: 'https://img.example/front.webp', order: 0, status: 'APPROVED' },
      { type: 'DAMAGE', url: 'https://img.example/pending.webp', order: -1, status: 'PENDING' },
    ],
    deliveryOptions: [
      {
        type: 'PICKUP',
        label: 'Pickup in Ponsonby',
        feeCents: 0,
        address: {
          street: 'Secret Street',
          city: 'Auckland',
          region: 'Auckland',
          postcode: '1011',
          location: point(174.744, -36.856),
        },
      },
    ],
    ...overrides,
  });
}

function queenstown() {
  return DestinationModel.create({
    slug: 'queenstown',
    city: 'Queenstown',
    maoriName: 'Tāhuna',
    region: 'Otago',
    tagline: 'Alpine roads, lakes and the ski fields.',
    intro: 'Queenstown sits on Lake Wakatipu.',
    location: point(168.6626, -45.0312),
    airports: ['ZQN'],
    featured: true,
    order: 1,
  });
}

const jsonLd = (html: string) =>
  JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)![1]!) as Record<
    string,
    unknown
  >;

describe('vehicle pages (/pages/cars/:slug)', () => {
  it('wraps the website’s index.html with the car’s own tags', async () => {
    await corolla();
    const response = await request(testApp()).get('/pages/cars/2021-toyota-corolla-auckland');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.headers['cache-control']).toBe('public, max-age=0, s-maxage=60');
    expect(response.headers['content-security-policy']).toBeUndefined();

    const html = response.text;
    expect(html).toContain(
      '<title data-prerendered>2021 Toyota Corolla for rent in Ponsonby, Auckland · Rento Vroom</title>',
    );
    expect(html).toContain('From $59 a day in NZD. 5 seats, automatic, hybrid. Rated 4.5 from 2 reviews.');
    expect(html).toContain(
      '<link data-prerendered rel="canonical" href="http://localhost:5173/cars/2021-toyota-corolla-auckland" />',
    );
    expect(html).toContain('<meta property="og:image" content="https://img.example/front.webp" />');
    expect(html).toContain('<script type="module" src="/assets/index-abc123.js"></script>');
    expect(html).not.toContain('<title>Rento Vroom</title>');
    // Never the pickup address or the number plate (plan §3, location privacy).
    expect(html).not.toContain('Secret Street');
    expect(html).not.toContain('ABC123');

    expect(jsonLd(html)).toMatchObject({
      '@type': 'Car',
      brand: { name: 'Toyota' },
      offers: { price: '59.00', priceCurrency: 'NZD' },
      aggregateRating: { ratingValue: 4.5, reviewCount: 2 },
    });
  });

  it('keeps the page out of search results until the website has built vehicle pages', async () => {
    website.manifest = { indexablePaths: ['/'], vehiclePages: false, destinationPages: false };
    await corolla();
    const html = (await request(testApp()).get('/pages/cars/2021-toyota-corolla-auckland')).text;

    expect(html).toContain('<meta data-prerendered name="robots" content="noindex, follow" />');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('application/ld+json');
    expect(html).toContain('<meta property="og:title"');
  });

  it('answers a real 404 for unknown and inactive cars', async () => {
    await corolla({ status: 'SUSPENDED' });
    for (const slug of ['2021-toyota-corolla-auckland', 'no-such-car']) {
      const response = await request(testApp()).get(`/pages/cars/${slug}`);
      expect(response.status).toBe(404);
      expect(response.text).toContain('<title data-prerendered>Page not found · Rento Vroom</title>');
      expect(response.text).toContain('noindex');
    }
  });

  it('escapes what hosts typed', async () => {
    await corolla({ make: 'Toyota "<script>"', slug: 'escaped' });
    const html = (await request(testApp()).get('/pages/cars/escaped')).text;
    expect(html).toContain('Toyota &quot;&lt;script&gt;&quot;');
    expect(html).not.toContain('"<script>"');
  });

  it('answers 502 when the website can’t be reached, so CloudFront serves the plain page', async () => {
    website.shell = null;
    await corolla();
    const response = await request(testApp()).get('/pages/cars/2021-toyota-corolla-auckland');
    expect(response.status).toBe(502);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('fetches the website’s index.html once a minute at most', async () => {
    await corolla();
    await request(testApp()).get('/pages/cars/2021-toyota-corolla-auckland');
    await request(testApp()).get('/pages/cars/2021-toyota-corolla-auckland');
    const shellFetches = fetchMock.mock.calls.filter(([url]) => (url as URL).pathname === '/index.html');
    expect(shellFetches).toHaveLength(1);
  });
});

describe('destination pages (/pages/rental/:city)', () => {
  it('has its own tags, even before any cars are listed there', async () => {
    await queenstown();
    const response = await request(testApp()).get('/pages/rental/Queenstown');

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      '<title data-prerendered>Car rental in Queenstown from local hosts · Rento Vroom</title>',
    );
    expect(response.text).toContain('Rent a car from local owners in Queenstown (Tāhuna).');
    expect(jsonLd(response.text)).toMatchObject({
      about: { '@type': 'City', name: 'Queenstown', geo: { latitude: -45.0312, longitude: 168.6626 } },
    });
  });

  it('answers 404 for places without a page', async () => {
    const response = await request(testApp()).get('/pages/rental/atlantis');
    expect(response.status).toBe(404);
  });

  it('answers 404 for an unpublished page, and the sitemap leaves it out', async () => {
    const destination = await queenstown();
    await DestinationModel.updateOne({ _id: destination._id }, { $set: { published: false } });

    const response = await request(testApp()).get('/pages/rental/queenstown');
    expect(response.status).toBe(404);
    expect(response.text).toContain('noindex');
    const sitemap = await request(testApp()).get('/pages/sitemap.xml');
    expect(sitemap.text).not.toContain('/rental/queenstown');

    // Published again, it's back.
    await DestinationModel.updateOne({ _id: destination._id }, { $set: { published: true } });
    expect((await request(testApp()).get('/pages/rental/queenstown')).status).toBe(200);
  });
});

describe('sitemap.xml', () => {
  it('lists the indexable pages, destinations and live cars', async () => {
    await corolla();
    await corolla({ slug: 'draft-car', status: 'DRAFT' });
    await queenstown();

    const response = await request(testApp()).get('/pages/sitemap.xml');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/xml/);
    expect(response.text).toContain('<loc>http://localhost:5173/</loc>');
    expect(response.text).toContain('<loc>http://localhost:5173/how-it-works</loc>');
    expect(response.text).toContain('<loc>http://localhost:5173/rental/queenstown</loc>');
    expect(response.text).toMatch(
      /<loc>http:\/\/localhost:5173\/cars\/2021-toyota-corolla-auckland<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/,
    );
    expect(response.text).not.toContain('draft-car');
  });

  it('leaves out kinds of page the website hasn’t built, and still answers if it can’t read the manifest', async () => {
    website.manifest = null;
    await corolla();
    await queenstown();

    const response = await request(testApp()).get('/pages/sitemap.xml');
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('<url>');
  });
});

describe('formatNzdFromCents', () => {
  it('shows whole dollars, like the website', () => {
    expect(formatNzdFromCents(8900)).toBe('$89');
    expect(formatNzdFromCents(129_950)).toBe('$1,300');
    expect(formatNzdFromCents(0)).toBe('$0');
  });
});
