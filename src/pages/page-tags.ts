import { formatNzdFromCents } from '../lib/format.js';
import type { Destination } from '../modules/cms/destination.model.js';
import type { FuelType, Transmission, Vehicle } from '../modules/vehicles/vehicle.model.js';

/*
 * The <head> tags for vehicle and destination pages (plan §1.4, item 2). They follow the frontend's own
 * tags for static pages (frontend/src/seo/head.ts), so the app's PageMeta can take them over the same way.
 */

/** index.html keeps its SEO tags between these markers; the frontend's build step uses the same ones. */
export const SEO_BLOCK = /<!-- seo:start -->[\s\S]*?<!-- seo:end -->/;
const PRERENDERED = 'data-prerendered';

const SITE_NAME = 'Rento Vroom';
const DEFAULT_DESCRIPTION =
  'Rent a car from local owners across New Zealand, or earn money by sharing your own car. All prices in NZD.';
/** The frontend's default link-preview image. */
const SHARE_IMAGE = { path: '/og-image.png', width: 1200, height: 630 };

export interface PageTags {
  /** The page name; " · Rento Vroom" is added after it. */
  title: string;
  description: string;
  path: string;
  /** False for pages search engines shouldn't list: not built yet on the website, or not found. */
  indexable: boolean;
  image?: { url: string; alt: string };
  structuredData?: object;
}

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function renderPageTags(page: PageTags, siteUrl: string): string {
  const title = `${page.title} · ${SITE_NAME}`;
  const url = `${siteUrl}${page.path}`;
  const image = page.image ?? { url: `${siteUrl}${SHARE_IMAGE.path}`, alt: title };
  const meta = (attribute: 'name' | 'property', key: string, content: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;

  const tags = [
    `<title ${PRERENDERED}>${escapeHtml(title)}</title>`,
    `<meta ${PRERENDERED} name="description" content="${escapeHtml(page.description)}" />`,
    !page.indexable && `<meta ${PRERENDERED} name="robots" content="noindex, follow" />`,
    page.indexable && `<link ${PRERENDERED} rel="canonical" href="${escapeHtml(url)}" />`,
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:locale', 'en_NZ'),
    meta('property', 'og:title', title),
    meta('property', 'og:description', page.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image.url),
    !page.image && meta('property', 'og:image:width', String(SHARE_IMAGE.width)),
    !page.image && meta('property', 'og:image:height', String(SHARE_IMAGE.height)),
    meta('property', 'og:image:alt', image.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    page.indexable &&
      page.structuredData &&
      // "<" is escaped so the JSON can never close the script tag early.
      `<script type="application/ld+json">${JSON.stringify(page.structuredData).replaceAll('<', '\\u003c')}</script>`,
  ];
  return tags.filter(Boolean).join('\n    ');
}

/** Swaps index.html's SEO block for new tags, keeping the markers. */
export function replaceSeoBlock(html: string, tags: string): string {
  return html.replace(SEO_BLOCK, () => `<!-- seo:start -->\n    ${tags}\n    <!-- seo:end -->`);
}

const FUEL_LABELS: Record<FuelType, string> = {
  PETROL: 'petrol',
  DIESEL: 'diesel',
  HYBRID: 'hybrid',
  PHEV: 'plug-in hybrid',
  EV: 'electric',
};
const TRANSMISSION_LABELS: Record<Transmission, string> = { AUTOMATIC: 'automatic', MANUAL: 'manual' };

type PublicVehicle = Pick<
  Vehicle,
  | 'slug'
  | 'make'
  | 'model'
  | 'year'
  | 'variant'
  | 'bodyType'
  | 'fuelType'
  | 'transmission'
  | 'seats'
  | 'suburb'
  | 'city'
  | 'pricing'
  | 'rating'
  | 'photos'
>;

/** A live listing's tags. The address and number plate are never included (plan §3, location privacy). */
export function vehiclePageTags(vehicle: PublicVehicle, indexable: boolean, siteUrl: string): PageTags {
  const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
  const place = [vehicle.suburb, vehicle.city].filter(Boolean).join(', ') || 'New Zealand';
  const path = `/cars/${vehicle.slug}`;
  const photo = vehicle.photos
    .filter((candidate) => candidate.status === 'APPROVED')
    .sort((a, b) => a.order - b.order)[0];

  const facts = [
    vehicle.seats && `${vehicle.seats} seats`,
    vehicle.transmission && TRANSMISSION_LABELS[vehicle.transmission],
    vehicle.fuelType && FUEL_LABELS[vehicle.fuelType],
  ].filter(Boolean);
  const description = [
    `Rent this ${[name, vehicle.variant].filter(Boolean).join(' ')} from a local host in ${place}.`,
    vehicle.pricing && `From ${formatNzdFromCents(vehicle.pricing.dailyCents)} a day in NZD.`,
    facts.length > 0 && `${facts.join(', ').replace(/^./, (first) => first.toUpperCase())}.`,
    vehicle.rating.count > 0 &&
      `Rated ${vehicle.rating.avg.toFixed(1)} from ${vehicle.rating.count} review${vehicle.rating.count === 1 ? '' : 's'}.`,
  ]
    .filter(Boolean)
    .join(' ');

  const price = vehicle.pricing && (vehicle.pricing.dailyCents / 100).toFixed(2);
  return {
    title: `${name} for rent in ${place}`,
    description,
    path,
    indexable,
    ...(photo && { image: { url: photo.url, alt: `${name} for rent in ${place}` } }),
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'Car',
      name,
      url: `${siteUrl}${path}`,
      ...(vehicle.make && { brand: { '@type': 'Brand', name: vehicle.make } }),
      ...(vehicle.model && { model: vehicle.model }),
      ...(vehicle.year && { vehicleModelDate: String(vehicle.year) }),
      ...(vehicle.fuelType && { fuelType: FUEL_LABELS[vehicle.fuelType] }),
      ...(vehicle.transmission && { vehicleTransmission: TRANSMISSION_LABELS[vehicle.transmission] }),
      ...(vehicle.seats && { seatingCapacity: vehicle.seats }),
      ...(photo && { image: photo.url }),
      ...(price && {
        offers: {
          '@type': 'Offer',
          price,
          priceCurrency: 'NZD',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price,
            priceCurrency: 'NZD',
            unitCode: 'DAY',
          },
          availability: 'https://schema.org/InStock',
        },
      }),
      ...(vehicle.rating.count > 0 && {
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: vehicle.rating.avg,
          reviewCount: vehicle.rating.count,
          bestRating: 5,
        },
      }),
    },
  };
}

type PublicDestination = Pick<
  Destination,
  'slug' | 'city' | 'maoriName' | 'region' | 'tagline' | 'heroImage' | 'location'
>;

/** A city or destination landing page's tags. A city with no cars yet still gets a normal page. */
export function destinationPageTags(
  destination: PublicDestination,
  indexable: boolean,
  siteUrl: string,
): PageTags {
  const path = `/rental/${destination.slug}`;
  const [lng, lat] = destination.location.coordinates;
  const called = destination.maoriName ? `${destination.city} (${destination.maoriName})` : destination.city;
  return {
    title: `Car rental in ${destination.city} from local hosts`,
    description: [
      `Rent a car from local owners in ${called}.`,
      destination.tagline,
      'All prices in NZD, with every mandatory fee included.',
    ]
      .filter(Boolean)
      .join(' '),
    path,
    indexable,
    ...(destination.heroImage && {
      image: { url: destination.heroImage, alt: `Car rental in ${destination.city}` },
    }),
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `Car rental in ${destination.city}`,
      url: `${siteUrl}${path}`,
      inLanguage: 'en-NZ',
      about: {
        '@type': 'City',
        name: destination.city,
        ...(destination.maoriName && { alternateName: destination.maoriName }),
        geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lng },
        containedInPlace: { '@type': 'AdministrativeArea', name: destination.region },
      },
    },
  };
}

export function notFoundPageTags(path: string): PageTags {
  return { title: 'Page not found', description: DEFAULT_DESCRIPTION, path, indexable: false };
}
