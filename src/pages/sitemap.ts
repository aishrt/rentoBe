import { DestinationModel } from '../modules/cms/destination.model.js';
import { VehicleModel } from '../modules/vehicles/vehicle.model.js';
import type { SeoManifest } from './frontend-shell.js';

/** A sitemap file holds at most 50,000 URLs; a sitemap index follows when the site gets near that. */
const MAX_VEHICLES = 45_000;

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const day = (date: Date) => date.toISOString().slice(0, 10);

/**
 * sitemap.xml (plan §1.4, item 4): the website's indexable static pages, live vehicles and destinations,
 * each only once the website has built that kind of page.
 */
export async function buildSitemap(siteUrl: string, manifest: SeoManifest): Promise<string> {
  const urls: { loc: string; lastmod?: Date }[] = manifest.indexablePaths.map((path) => ({
    loc: path === '/' ? `${siteUrl}/` : `${siteUrl}${path}`,
  }));

  if (manifest.destinationPages) {
    const destinations = await DestinationModel.find().select('slug updatedAt').sort({ order: 1 }).lean();
    urls.push(
      ...destinations.map((destination) => ({
        loc: `${siteUrl}/rental/${destination.slug}`,
        lastmod: destination.updatedAt,
      })),
    );
  }

  if (manifest.vehiclePages) {
    const vehicles = await VehicleModel.find({ status: 'ACTIVE' })
      .select('slug updatedAt')
      .sort({ updatedAt: -1 })
      .limit(MAX_VEHICLES)
      .lean();
    urls.push(
      ...vehicles.map((vehicle) => ({ loc: `${siteUrl}/cars/${vehicle.slug}`, lastmod: vehicle.updatedAt })),
    );
  }

  const entries = urls.map(
    ({ loc, lastmod }) =>
      `  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${day(lastmod)}</lastmod>` : ''}</url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}
