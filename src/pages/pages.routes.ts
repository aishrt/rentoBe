import { Router, type Response } from 'express';
import helmet from 'helmet';
import { env } from '../env.js';
import { DestinationModel } from '../modules/cms/destination.model.js';
import { VehicleModel } from '../modules/vehicles/vehicle.model.js';
import { getAppShell, getSeoManifest } from './frontend-shell.js';
import {
  destinationPageTags,
  notFoundPageTags,
  renderPageTags,
  replaceSeoBlock,
  vehiclePageTags,
  type PageTags,
} from './page-tags.js';
import { buildSitemap } from './sitemap.js';

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');

/**
 * Mounted at /pages. The website's CloudFront sends /cars/*, /rental/* and /sitemap.xml here (plan §1.4,
 * §13): vehicle and destination pages get their own title, description, link-preview tags and JSON-LD
 * around the website's current index.html, and then load the same app as every other page.
 */
export function pagesRouter() {
  const router = Router();
  // These are the website's pages, loading its own scripts, styles and images, so the API's strict
  // Content-Security-Policy (made for JSON responses) would break them.
  router.use(helmet({ contentSecurityPolicy: false }));

  async function sendPage(res: Response, status: 200 | 404, tags: PageTags) {
    let shell: string;
    try {
      shell = await getAppShell();
    } catch (error) {
      res.log.error({ err: error }, 'Could not load the website’s index.html for page tags');
      // CloudFront serves the plain index.html instead, so the page still opens (plan §1.4).
      res.status(502).type('text/plain').set('Cache-Control', 'no-store').send('Website unavailable');
      return;
    }
    res
      .status(status)
      .type('html')
      .set('Cache-Control', 'public, max-age=0, s-maxage=60')
      .send(replaceSeoBlock(shell, renderPageTags(tags, siteUrl())));
  }

  router.get('/cars/:slug', async (req, res) => {
    const vehicle = await VehicleModel.findOne({ slug: req.params.slug.toLowerCase() }).lean();
    // An unknown, draft, inactive or suspended car is a real 404.
    if (!vehicle || vehicle.status !== 'ACTIVE') {
      return sendPage(res, 404, notFoundPageTags(`/cars/${req.params.slug}`));
    }
    const { vehiclePages } = await getSeoManifest();
    return sendPage(res, 200, vehiclePageTags(vehicle, vehiclePages, siteUrl()));
  });

  router.get('/rental/:city', async (req, res) => {
    const destination = await DestinationModel.findOne({ slug: req.params.city.toLowerCase() }).lean();
    if (!destination) return sendPage(res, 404, notFoundPageTags(`/rental/${req.params.city}`));
    const { destinationPages } = await getSeoManifest();
    return sendPage(res, 200, destinationPageTags(destination, destinationPages, siteUrl()));
  });

  router.get('/sitemap.xml', async (_req, res) => {
    const xml = await buildSitemap(siteUrl(), await getSeoManifest());
    res.type('application/xml').set('Cache-Control', 'public, max-age=0, s-maxage=3600').send(xml);
  });

  return router;
}
