import { emailTheme } from '../../emails/theme.js';
import { env } from '../../env.js';

/*
 * The listing's area map (plan §1.2, spec §22): a Maps Static API image of the approximate area as a
 * shaded circle, never a pin. This API fetches it with GOOGLE_MAPS_SERVER_KEY, the same key as Google
 * Places, so the key never reaches the browser (the owner's choice, 07/10/2026: one key for everything
 * Google). Without the key, listings show the website's drawn sketch instead.
 */

export interface Area {
  lat: number;
  lng: number;
  radiusM: number;
}

export interface MapImage {
  body: Buffer;
  contentType: string;
}

const STATIC_MAPS = 'https://maps.googleapis.com/maps/api/staticmap';
const TIMEOUT_MS = 4_000;
const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/** Points around the circle, "lat,lng|lat,lng|…", for the static map's shaded area. */
function circlePath({ lat, lng, radiusM }: Area, points = 48): string {
  const distance = radiusM / EARTH_RADIUS_M;
  const latR = toRadians(lat);
  const lngR = toRadians(lng);
  return Array.from({ length: points + 1 }, (_, index) => {
    const bearing = (index / points) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(latR) * Math.cos(distance) + Math.cos(latR) * Math.sin(distance) * Math.cos(bearing),
    );
    const lng2 =
      lngR +
      Math.atan2(
        Math.sin(bearing) * Math.sin(distance) * Math.cos(latR),
        Math.cos(distance) - Math.sin(latR) * Math.sin(lat2),
      );
    return `${toDegrees(lat2).toFixed(5)},${toDegrees(lng2).toFixed(5)}`;
  }).join('|');
}

/** A zoom where the circle fills about a third of the map's height. */
function zoomFor({ lat, radiusM }: Area): number {
  const metresPerPixel = radiusM / 60;
  const zoom = Math.log2((156_543.03 * Math.cos(toRadians(lat))) / metresPerPixel);
  return Math.max(8, Math.min(15, Math.floor(zoom)));
}

/** The Maps Static API request for an area, in the brand blue, without points of interest or transit. */
export function areaMapUrl(area: Area, key: string): URL {
  const blue = emailTheme.colors.primary.replace('#', '0x');
  const url = new URL(STATIC_MAPS);
  url.searchParams.set('center', `${area.lat},${area.lng}`);
  url.searchParams.set('zoom', String(zoomFor(area)));
  url.searchParams.set('size', '640x360');
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'roadmap');
  url.searchParams.append('path', `color:${blue}B3|weight:2|fillcolor:${blue}2E|${circlePath(area)}`);
  url.searchParams.append('style', 'feature:poi|visibility:off');
  url.searchParams.append('style', 'feature:transit|visibility:off');
  url.searchParams.set('key', key);
  return url;
}

/** Whether listings have a map: the Google key is set. */
export const areaMapsEnabled = () => Boolean(env.GOOGLE_MAPS_SERVER_KEY);

/** Where the website loads a car's map from: this API, so the browser never needs the key. */
export function areaMapLink(vehicleId: string, area: Area): string | null {
  if (!areaMapsEnabled()) return null;
  // The centre in the link, so a browser's cached map is replaced when the car moves.
  const version = encodeURIComponent(`${area.lat},${area.lng}`);
  return `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/vehicles/${vehicleId}/area-map?v=${version}`;
}

/** The map image from Google, or null without a key. Throws when Google refuses it (billing, quota, key). */
export async function fetchAreaMap(area: Area): Promise<MapImage | null> {
  if (!env.GOOGLE_MAPS_SERVER_KEY) return null;
  const response = await fetch(areaMapUrl(area, env.GOOGLE_MAPS_SERVER_KEY), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const contentType = response.headers.get('content-type') ?? '';
  // Google answers a refused key with a 403 and a text message, never an image.
  if (!response.ok || !contentType.startsWith('image/')) {
    throw new Error(
      `Google Maps Static API answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}
