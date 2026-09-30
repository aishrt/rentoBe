import { env } from '../../env.js';
import type { NzRegion } from '../../lib/model-fields.js';
import { NZ_REGIONS } from '../../lib/model-fields.js';
import { logger } from '../logger.js';

/*
 * Street addresses and anything not in our own places list come from Google Places (plan §1.2):
 * Autocomplete restricted to New Zealand, and Place Details for the chosen one, with one session
 * token per search so each search is billed once. Until the client's Google Cloud account arrives
 * (plan §9, Waiting for the client), PLACES_DRIVER=local answers from our places collection only.
 */

export interface AddressSuggestion {
  /** Google's place id. */
  placeId: string;
  /** "12 Queen Street". */
  main: string;
  /** "Auckland Central, Auckland". */
  secondary?: string;
}

export interface AddressDetails {
  placeId: string;
  label: string;
  lat: number;
  lng: number;
  /** Filled in when Google has every part an NZ address needs (plan §3). */
  address?: {
    unit?: string;
    streetNumber?: string;
    street: string;
    suburb?: string;
    city: string;
    region: NzRegion;
    postcode: string;
  };
}

export interface PlacesProvider {
  readonly provider: 'google' | 'local';
  suggest(query: string, sessionToken?: string): Promise<AddressSuggestion[]>;
  details(placeId: string, sessionToken?: string): Promise<AddressDetails | null>;
}

const GOOGLE_PLACES = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 4_000;

interface GoogleComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

/** Google's region names drop macrons and apostrophes in places; match on the plain letters. */
const plain = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();

function toRegion(value: string | undefined): NzRegion | undefined {
  if (!value) return undefined;
  const wanted = plain(value.replace(/\s+Region$/i, ''));
  return NZ_REGIONS.find((region) => plain(region) === wanted);
}

export function createGooglePlaces(apiKey: string, fetchImpl: typeof fetch = fetch): PlacesProvider {
  const headers = { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json' };

  return {
    provider: 'google',

    async suggest(query, sessionToken) {
      const response = await fetchImpl(`${GOOGLE_PLACES}/places:autocomplete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: query,
          includedRegionCodes: ['nz'],
          languageCode: 'en-NZ',
          sessionToken,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Google Places autocomplete answered ${response.status}`);
      const body = (await response.json()) as {
        suggestions?: {
          placePrediction?: {
            placeId: string;
            text?: { text: string };
            structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
          };
        }[];
      };
      return (body.suggestions ?? []).flatMap(({ placePrediction: prediction }) =>
        prediction
          ? [
              {
                placeId: prediction.placeId,
                main: prediction.structuredFormat?.mainText?.text ?? prediction.text?.text ?? '',
                secondary: prediction.structuredFormat?.secondaryText?.text?.replace(/, New Zealand$/, ''),
              },
            ]
          : [],
      );
    },

    async details(placeId, sessionToken) {
      const url = new URL(`${GOOGLE_PLACES}/places/${encodeURIComponent(placeId)}`);
      url.searchParams.set('languageCode', 'en-NZ');
      if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
      const response = await fetchImpl(url, {
        headers: { ...headers, 'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 400) return null;
      if (!response.ok) throw new Error(`Google Place Details answered ${response.status}`);
      const place = (await response.json()) as {
        id: string;
        formattedAddress?: string;
        location?: { latitude: number; longitude: number };
        addressComponents?: GoogleComponent[];
      };
      if (!place.location) return null;

      const part = (type: string) =>
        place.addressComponents?.find((component) => component.types?.includes(type));
      const street = part('route')?.longText;
      const city = (part('locality') ?? part('postal_town'))?.longText;
      const region = toRegion(part('administrative_area_level_1')?.longText);
      const postcode = part('postal_code')?.longText;

      return {
        placeId: place.id,
        label: (place.formattedAddress ?? '').replace(/, New Zealand$/, ''),
        lat: place.location.latitude,
        lng: place.location.longitude,
        ...(street &&
          city &&
          region &&
          postcode &&
          /^\d{4}$/.test(postcode) && {
            address: {
              unit: part('subpremise')?.longText,
              streetNumber: part('street_number')?.longText,
              street,
              suburb: (part('sublocality_level_1') ?? part('sublocality'))?.longText,
              city,
              region,
              postcode,
            },
          }),
      };
    },
  };
}

/** Our own places only: no street addresses. */
export const localPlaces: PlacesProvider = {
  provider: 'local',
  async suggest() {
    return [];
  },
  async details() {
    return null;
  },
};

let provider: PlacesProvider | undefined;

export function getPlacesProvider(): PlacesProvider {
  if (!provider) {
    provider =
      env.PLACES_DRIVER === 'google' && env.GOOGLE_MAPS_SERVER_KEY
        ? createGooglePlaces(env.GOOGLE_MAPS_SERVER_KEY)
        : localPlaces;
    logger.debug({ provider: provider.provider }, 'Places provider ready');
  }
  return provider;
}
