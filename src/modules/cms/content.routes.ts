import { Router, type Response } from 'express';
import mongoose from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { memo } from '../../lib/memo.js';
import { validate } from '../../lib/validate.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { FaqModel } from '../help/faq.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import { CmsBlockModel, type LegalContent } from './cms-block.model.js';
import { faqsQuerySchema, LEGAL_PAGE_KEYS, type PublicPolicies } from './content.schemas.js';
import { DestinationModel, type Destination } from './destination.model.js';

/*
 * Public content (plan §11): destinations, FAQs, legal pages, the settings the public pages show,
 * and the homepage's customer reviews. Cached for 60 s per task (plan §4.1).
 */

const CACHE_MS = 60_000;
const notFound = (message: string) => new HttpError(404, 'NOT_FOUND', message);
/** Browsers and CloudFront may keep public content for a minute. */
const cacheable = (res: Response) => res.set('Cache-Control', 'public, max-age=60');

function toDestination(destination: Destination) {
  const [lng, lat] = destination.location.coordinates;
  return {
    slug: destination.slug,
    city: destination.city,
    ...(destination.maoriName && { maoriName: destination.maoriName }),
    region: destination.region,
    ...(destination.tagline && { tagline: destination.tagline }),
    ...(destination.heroImage && { heroImage: destination.heroImage }),
    lat,
    lng,
    airports: destination.airports,
  };
}

/** Mounted at /api/v1/destinations. */
export function destinationsRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    const destinations = await memo('destinations', CACHE_MS, () =>
      DestinationModel.find().sort({ featured: -1, order: 1, city: 1 }).lean(),
    );
    cacheable(res).json({ destinations: destinations.map(toDestination) });
  });

  router.get('/:slug', async (req, res) => {
    const destination = await DestinationModel.findOne({
      slug: String(req.params.slug).toLowerCase(),
    }).lean();
    if (!destination) throw notFound("We couldn't find that destination.");
    cacheable(res).json({ destination: { ...toDestination(destination), intro: destination.intro } });
  });

  return router;
}

/** Mounted at /api/v1/cms. Only the legal pages are public (plan §9, Days 12–14). */
export function cmsRouter() {
  const router = Router();

  router.get('/:key', async (req, res) => {
    const key = String(req.params.key);
    if (!(LEGAL_PAGE_KEYS as readonly string[]).includes(key)) throw notFound('No such page.');
    const block = await CmsBlockModel.findOne({ key }).lean();
    if (!block) throw notFound('No such page.');
    const content = block.content as LegalContent;
    cacheable(res).json({
      page: {
        key,
        version: block.version,
        title: content.title,
        markdown: content.markdown,
        updatedAt: block.updatedAt.toISOString(),
      },
    });
  });

  return router;
}

/** Mounted at /api/v1/faqs. */
export function faqsRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    const { audience, home } = validate(faqsQuerySchema, req.query);
    const faqs = await memo('faqs', CACHE_MS, () => FaqModel.find().sort({ order: 1, createdAt: 1 }).lean());
    cacheable(res).json({
      faqs: faqs
        .filter((faq) => !home || faq.showOnHome)
        .filter((faq) => !audience || faq.audience === 'ALL' || faq.audience === audience)
        .map((faq) => ({
          id: faq._id.toString(),
          question: faq.question,
          answer: faq.answer,
          category: faq.category,
          audience: faq.audience,
        })),
    });
  });

  return router;
}

/** GET /api/v1/policies: fees, cancellation tiers, protection plans and listing rules for public pages. */
export function policiesRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    const settings = await getPlatformSettings();
    const policies: PublicPolicies = {
      fees: {
        guestServiceFeePct: settings.fees.guestServiceFeePct,
        hostCommissionPct: settings.fees.hostCommissionPct,
        gstRatePct: settings.fees.gstRatePct,
      },
      cancellation: {
        tiers: settings.cancellation.tiers,
        hostSelectableTiers: settings.cancellation.hostSelectableTiers,
        defaultTier: settings.cancellation.defaultTier,
        hostCancellationFeeCents: settings.cancellation.hostCancellationFeeCents,
      },
      protectionPlans: settings.protectionPlans,
      roadsideAssistance: settings.roadsideAssistance,
      eligibility: settings.eligibility,
      vehicles: settings.vehicles,
      search: settings.search,
      hostEstimator: settings.hostEstimator,
      reviews: { windowDays: settings.reviews.windowDays },
      trips: { lateReturnGraceMinutes: settings.trips.lateReturnGraceMinutes },
    };
    cacheable(res).json(policies);
  });

  return router;
}

const FEATURED_REVIEWS = 6;

/** Mounted at /api/v1/reviews. */
export function reviewsRouter() {
  const router = Router();

  // The homepage's customer reviews: real published reviews only, hidden until there are enough (plan §12.6).
  router.get('/featured', async (_req, res) => {
    const body = await memo('reviews:featured', CACHE_MS, async () => {
      const settings = await getPlatformSettings();
      const published = { direction: 'GUEST_TO_HOST', status: 'PUBLISHED', 'moderation.state': 'CLEAR' };
      const total = await ReviewModel.countDocuments(published);
      if (total < settings.reviews.homepageThreshold) return { show: false, reviews: [] };

      const reviews = await ReviewModel.find({
        ...published,
        overall: mongoose.trusted({ $gte: 4 }),
        body: mongoose.trusted({ $type: 'string', $ne: '' }),
      })
        .sort({ createdAt: -1 })
        .limit(FEATURED_REVIEWS)
        .lean();
      const [authors, vehicles] = await Promise.all([
        UserModel.find({ _id: mongoose.trusted({ $in: reviews.map((review) => review.authorId) }) })
          .select('firstName avatarUrl')
          .lean(),
        VehicleModel.find({ _id: mongoose.trusted({ $in: reviews.map((review) => review.vehicleId) }) })
          .select('year make model city')
          .lean(),
      ]);
      return {
        show: reviews.length > 0,
        reviews: reviews.map((review) => {
          const author = authors.find((candidate) => candidate._id.equals(review.authorId));
          const vehicle = vehicles.find(
            (candidate) => review.vehicleId && candidate._id.equals(review.vehicleId),
          );
          return {
            id: review._id.toString(),
            author: {
              firstName: author?.firstName ?? 'A guest',
              ...(author?.avatarUrl && { avatarUrl: author.avatarUrl }),
            },
            overall: review.overall,
            body: review.body ?? '',
            vehicleTitle: vehicle ? vehicleTitle(vehicle) : 'A local car',
            ...(vehicle?.city && { city: vehicle.city }),
            createdAt: review.createdAt.toISOString(),
          };
        }),
      };
    });
    cacheable(res).json(body);
  });

  return router;
}
