import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/env.js';
import { forget } from '../src/lib/memo.js';
import { createHost, createVehicle } from './fixtures.js';
import { testApp } from './helpers.js';

/*
 * The listing's area map (plan §1.2): this API fetches it from Google with the one server key, the same
 * key as Google Places, so the website never holds a Google key.
 */

const app = testApp();
const KEY = 'test-google-key-0123456789abcdef';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stubGoogle(response: () => Response) {
  const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const pathOf = (link: string) => {
  const url = new URL(link);
  return url.pathname + url.search;
};

const savedKey = env.GOOGLE_MAPS_SERVER_KEY;

beforeEach(() => {
  forget();
  env.GOOGLE_MAPS_SERVER_KEY = KEY;
});

afterEach(() => {
  env.GOOGLE_MAPS_SERVER_KEY = savedKey;
  vi.unstubAllGlobals();
});

describe('Listing area map', () => {
  it('links the listing to a map this API serves, fetched from Google with the server key', async () => {
    const vehicle = await createVehicle((await createHost())._id);
    const google = stubGoogle(() => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));

    const listing = await request(app).get(`/api/v1/vehicles/${vehicle.slug}`);
    const { approx, mapUrl } = listing.body.vehicle.location;
    expect(mapUrl).toBe(
      `http://localhost:4000/api/v1/vehicles/${vehicle.id}/area-map?v=${encodeURIComponent(`${approx.lat},${approx.lng}`)}`,
    );
    expect(mapUrl).not.toContain(KEY);

    const map = await request(app).get(pathOf(mapUrl));
    expect(map.status).toBe(200);
    expect(map.headers['content-type']).toBe('image/png');
    expect(map.headers['cache-control']).toBe('public, max-age=86400');
    expect(map.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(Buffer.compare(map.body, PNG)).toBe(0);

    const sent = new URL(google.mock.calls[0]![0]);
    expect(sent.origin + sent.pathname).toBe('https://maps.googleapis.com/maps/api/staticmap');
    expect(sent.searchParams.get('key')).toBe(KEY);
    expect(sent.searchParams.get('center')).toBe(`${approx.lat},${approx.lng}`);
    expect(sent.searchParams.get('path')).toMatch(/^color:0x0254C2B3\|weight:2\|fillcolor:0x0254C22E\|/);
    // An area, never a pin on the car (spec §22).
    expect(sent.searchParams.has('markers')).toBe(false);
  });

  it('has no map without the key, and never asks Google', async () => {
    env.GOOGLE_MAPS_SERVER_KEY = undefined;
    const vehicle = await createVehicle((await createHost())._id);
    const google = stubGoogle(() => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));

    const listing = await request(app).get(`/api/v1/vehicles/${vehicle.slug}`);
    expect(listing.body.vehicle.location.mapUrl).toBeNull();

    const map = await request(app).get(`/api/v1/vehicles/${vehicle.id}/area-map`);
    expect(map.status).toBe(503);
    expect(google).not.toHaveBeenCalled();
  });

  it('answers 503 when Google refuses the key, so the website shows its sketch', async () => {
    const vehicle = await createVehicle((await createHost())._id);
    stubGoogle(
      () =>
        new Response('You must enable Billing on the Google Cloud Project', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        }),
    );

    const map = await request(app).get(`/api/v1/vehicles/${vehicle.id}/area-map`);
    expect(map.status).toBe(503);
    expect(map.body.error.code).toBe('MAP_UNAVAILABLE');
  });

  it('is a 404 for cars that are not live, without asking Google', async () => {
    const draft = await createVehicle((await createHost())._id, { status: 'DRAFT' });
    const google = stubGoogle(() => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));

    expect((await request(app).get(`/api/v1/vehicles/${draft.id}/area-map`)).status).toBe(404);
    expect((await request(app).get('/api/v1/vehicles/not-an-id/area-map')).status).toBe(404);
    expect(google).not.toHaveBeenCalled();
  });
});
