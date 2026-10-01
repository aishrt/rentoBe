import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as placesModule from '../src/integrations/places/places-provider.js';
import { createGooglePlaces, type PlacesProvider } from '../src/integrations/places/places-provider.js';
import { forget } from '../src/lib/memo.js';
import { createPlaces } from './fixtures.js';
import { testApp } from './helpers.js';

/*
 * The Google Places driver against Google's documented request and response shapes (Places API New),
 * so switching on PLACES_DRIVER=google works the first time the client's key arrives.
 */

const fakeGoogle = vi.hoisted(() => ({
  suggest: vi.fn(),
  details: vi.fn(),
}));

vi.mock('../src/integrations/places/places-provider.js', async (original) => ({
  ...(await original<typeof placesModule>()),
  getPlacesProvider: (): PlacesProvider => ({ provider: 'google', ...fakeGoogle }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Place Details for a Palmerston North address, with the region named as before 2019. */
const PALMERSTON_NORTH = {
  id: 'ChIJpalmy',
  formattedAddress: '12 The Square, Palmerston North Central, Palmerston North 4410, New Zealand',
  location: { latitude: -40.3523, longitude: 175.6082 },
  addressComponents: [
    { longText: '12', shortText: '12', types: ['street_number'] },
    { longText: 'The Square', shortText: 'The Square', types: ['route'] },
    {
      longText: 'Palmerston North Central',
      shortText: 'Palmerston North Central',
      types: ['sublocality_level_1', 'sublocality', 'political'],
    },
    { longText: 'Palmerston North', shortText: 'Palmerston North', types: ['locality', 'political'] },
    {
      longText: 'Manawatu-Wanganui',
      shortText: 'Manawatu-Wanganui',
      types: ['administrative_area_level_1', 'political'],
    },
    { longText: 'New Zealand', shortText: 'NZ', types: ['country', 'political'] },
    { longText: '4410', shortText: '4410', types: ['postal_code'] },
  ],
};

describe('Google Places driver', () => {
  it('asks Autocomplete for NZ places in a language Google supports, with the session token', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        suggestions: [
          {
            placePrediction: {
              placeId: 'ChIJqueen',
              text: { text: '12 Queen Street, Auckland Central, Auckland, New Zealand' },
              structuredFormat: {
                mainText: { text: '12 Queen Street' },
                secondaryText: { text: 'Auckland Central, Auckland, New Zealand' },
              },
            },
          },
          // Query predictions carry no place; they're skipped.
          { queryPrediction: { text: { text: 'queen street cafes' } } },
        ],
      }),
    );
    const google = createGooglePlaces('test-key-0123456789abcdef', fetchImpl);

    const suggestions = await google.suggest('12 queen st', 'token-1');

    expect(suggestions).toEqual([
      { placeId: 'ChIJqueen', main: '12 Queen Street', secondary: 'Auckland Central, Auckland' },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Goog-Api-Key': 'test-key-0123456789abcdef' });
    expect(JSON.parse(String(init.body))).toEqual({
      input: '12 queen st',
      includedRegionCodes: ['nz'],
      // Google's supported languages have no en-NZ; an unsupported one is an INVALID_ARGUMENT error.
      languageCode: 'en-GB',
      sessionToken: 'token-1',
    });
  });

  it('reads an NZ address from Place Details, including the region under its old name', async () => {
    const fetchImpl = vi.fn(async () => json(PALMERSTON_NORTH));
    const google = createGooglePlaces('test-key-0123456789abcdef', fetchImpl);

    const details = await google.details('ChIJpalmy', 'token-1');

    expect(details).toEqual({
      placeId: 'ChIJpalmy',
      label: '12 The Square, Palmerston North Central, Palmerston North 4410',
      lat: -40.3523,
      lng: 175.6082,
      address: {
        unit: undefined,
        streetNumber: '12',
        street: 'The Square',
        suburb: 'Palmerston North Central',
        city: 'Palmerston North',
        region: 'Manawatū-Whanganui',
        postcode: '4410',
      },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://places.googleapis.com/v1/places/ChIJpalmy?languageCode=en-GB&sessionToken=token-1',
    );
    expect(init.headers).toMatchObject({
      'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents',
    });
  });

  it('gives coordinates without a structured address when Google lacks a part, and null for an unknown place', async () => {
    const noPostcode = {
      ...PALMERSTON_NORTH,
      addressComponents: PALMERSTON_NORTH.addressComponents.filter(
        (component) => !component.types.includes('postal_code'),
      ),
    };
    const google = createGooglePlaces('test-key-0123456789abcdef', async () => json(noPostcode));
    const details = await google.details('ChIJpalmy');
    expect(details).toMatchObject({ lat: -40.3523, lng: 175.6082 });
    expect(details?.address).toBeUndefined();

    const missing = createGooglePlaces('test-key-0123456789abcdef', async () =>
      json({ error: { code: 404, status: 'NOT_FOUND' } }, 404),
    );
    expect(await missing.details('ChIJgone')).toBeNull();
  });

  it('throws when Google refuses the key, so the caller can fall back', async () => {
    const google = createGooglePlaces('test-key-0123456789abcdef', async () =>
      json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403),
    );
    await expect(google.suggest('queen')).rejects.toThrow(/403/);
  });
});

describe('Place suggestions with Google switched on', () => {
  const app = testApp();

  beforeEach(async () => {
    forget();
    fakeGoogle.suggest
      .mockReset()
      .mockResolvedValue([
        { placeId: 'ChIJqueen', main: '12 Queen Street', secondary: 'Auckland Central, Auckland' },
      ]);
    await createPlaces();
  });

  it('adds street addresses after our places', async () => {
    const response = await request(app).get('/api/v1/places/suggest').query({ q: 'auck', sessionToken: 't' });
    expect(response.status).toBe(200);
    expect(response.body.suggestions[0]).toMatchObject({ type: 'CITY', name: 'Auckland' });
    expect(response.body.suggestions.at(-1)).toMatchObject({
      id: 'google:ChIJqueen',
      type: 'ADDRESS',
      label: '12 Queen Street, Auckland Central, Auckland',
    });
    expect(fakeGoogle.suggest).toHaveBeenCalledWith('auck', 't');
  });

  it("doesn't ask Google for the Host's place picker, which types the street itself", async () => {
    const response = await request(app).get('/api/v1/places/suggest').query({ q: 'auck', oursOnly: 'true' });
    expect(response.status).toBe(200);
    expect(response.body.suggestions.length).toBeGreaterThan(0);
    expect(response.body.suggestions.every((place: { type: string }) => place.type !== 'ADDRESS')).toBe(true);
    expect(fakeGoogle.suggest).not.toHaveBeenCalled();
  });

  it('still shows our places when Google fails', async () => {
    fakeGoogle.suggest.mockRejectedValue(new Error('Google Places autocomplete answered 403'));
    const response = await request(app).get('/api/v1/places/suggest').query({ q: 'auck' });
    expect(response.status).toBe(200);
    expect(response.body.suggestions[0]).toMatchObject({ name: 'Auckland' });
  });
});
