import { Router, type Response } from 'express';
import mongoose from 'mongoose';
import { HttpError } from '../../lib/http-error.js';
import { memo } from '../../lib/memo.js';
import { validate } from '../../lib/validate.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { FaqModel } from '../help/faq.model.js';
import { ReviewModel } from '../reviews/review.model.js';
import { CmsBlockModel, type LegalContent } from './cms-block.model.js';
import { faqsQuerySchema, LEGAL_PAGE_KEYS, type PublicPolicies } from './content.schemas.js';
import { DestinationModel, publishedDestination, type Destination } from './destination.model.js';
import {
  FOOTER_BLOCK_KEY,
  HERO_BLOCK_KEY,
  MAX_FEATURED_REVIEWS,
  PUBLISHED_REVIEW,
  homeHero,
  pickedReviewIds,
  quotableReview,
  reviewCards,
  siteFooter,
} from './site-content.js';

/*
 * Public content (plan §11): destinations, FAQs, legal pages, the homepage text and footer links, the
 * settings the public pages show, and the homepage's customer reviews. Cached for 60 s per task (plan §4.1).
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
    airports: destination.airports ?? [],
    featured: destination.featured === true,
  };
}

/** Mounted at /api/v1/destinations. */
export function destinationsRouter() {
  const router = Router();

  // Published pages only: an unpublished one is off the homepage and answers 404.
  router.get('/', async (_req, res) => {
    const destinations = await memo('destinations', CACHE_MS, () =>
      DestinationModel.find(publishedDestination()).sort({ featured: -1, order: 1, city: 1 }).lean(),
    );
    cacheable(res).json({ destinations: destinations.map(toDestination) });
  });

  router.get('/:slug', async (req, res) => {
    const destination = await DestinationModel.findOne({
      slug: String(req.params.slug).toLowerCase(),
      ...publishedDestination(),
    }).lean();
    if (!destination) throw notFound("We couldn't find that destination.");
    cacheable(res).json({ destination: { ...toDestination(destination), intro: destination.intro } });
  });

  return router;
}

/**
 * Mounted at /api/v1/cms. Public: the legal pages (plan §9, Days 12–14), the homepage's headline and the
 * footer's links (plan §12.6), with the original ones until an admin saves their own.
 */
export function cmsRouter() {
  const router = Router();

  router.get('/:key', async (req, res) => {
    const key = String(req.params.key);
    if (key === HERO_BLOCK_KEY) {
      cacheable(res).json({ hero: (await homeHero()).content });
      return;
    }
    if (key === FOOTER_BLOCK_KEY) {
      cacheable(res).json({ footer: (await siteFooter()).content });
      return;
    }
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

/** Mounted at /api/v1/reviews. */
export function reviewsRouter() {
  const router = Router();

  /*
   * The homepage's customer reviews: real published reviews only, hidden until there are enough (plan
   * §12.6). Those an admin picked, in their order, leaving out any hidden since; with none (or none still
   * published), the newest well-rated reviews with words to quote.
   */
  router.get('/featured', async (_req, res) => {
    const body = await memo('reviews:featured', CACHE_MS, async () => {
      const settings = await getPlatformSettings();
      const total = await ReviewModel.countDocuments(PUBLISHED_REVIEW);
      if (total < settings.reviews.homepageThreshold) return { show: false, reviews: [] };

      const picked = await pickedReviewIds();
      const found = picked.length
        ? await ReviewModel.find({ _id: mongoose.trusted({ $in: picked }), ...quotableReview() }).lean()
        : [];
      let reviews = picked.flatMap((id) => found.filter((review) => review._id.equals(id)));
      if (reviews.length === 0) {
        reviews = await ReviewModel.find({ ...quotableReview(), overall: mongoose.trusted({ $gte: 4 }) })
          .sort({ createdAt: -1 })
          .limit(MAX_FEATURED_REVIEWS)
          .lean();
      }
      return { show: reviews.length > 0, reviews: await reviewCards(reviews) };
    });
    cacheable(res).json(body);
  });

  return router;
}
