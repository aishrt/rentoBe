import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { point } from '../../lib/model-fields.js';
import { recordAudit } from '../audit/audit.service.js';
import { CmsBlockModel, type LegalContent } from '../cms/cms-block.model.js';
import { LEGAL_PAGE_KEYS, type HomeHero, type SiteFooter } from '../cms/content.schemas.js';
import { DestinationModel, type Destination } from '../cms/destination.model.js';
import {
  FEATURED_REVIEWS_BLOCK_KEY,
  FOOTER_BLOCK_KEY,
  HERO_BLOCK_KEY,
  PUBLISHED_REVIEW,
  homeHero,
  pickedReviewIds,
  quotableReview,
  reviewCards,
  siteFooter,
} from '../cms/site-content.js';
import { FaqModel, type Faq } from '../help/faq.model.js';
import { HelpArticleModel, type HelpArticle } from '../help/help-article.model.js';
import { ReviewModel, type Review } from '../reviews/review.model.js';
import { PlaceModel } from '../search/place.model.js';
import { FEATURED_BLOCK_KEY } from '../vehicles/vehicles.service.js';
import { liveVehicleFilter, VehicleModel, type Vehicle } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import type {
  destinationCreateSchema,
  destinationEditSchema,
  faqInputSchema,
  helpArticleInputSchema,
  legalPageEditSchema,
} from './admin-ops.schemas.js';
import { getPlatformSettings } from './platform-settings.service.js';

/*
 * Content in the staff portal (spec §18; plan §9 Days 19–23, §12.6), admin only: the homepage's headline,
 * featured cars and customer reviews, the footer's links, the legal pages, destination landing pages, FAQs
 * (and which show on the homepage) and help articles. Public pages cache content for a minute; a change
 * clears that cache at once on this task.
 */

type Id = Types.ObjectId;
type VehicleRecord = Vehicle & { _id: Id };
type ReviewRecord = Review & { _id: Id };
type LegalKey = (typeof LEGAL_PAGE_KEYS)[number];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDuplicate = (error: unknown) =>
  error instanceof mongoose.mongo.MongoServerError && error.code === 11000;

async function audit(
  staffId: string,
  action: string,
  entity: string,
  entityId: string,
  after?: unknown,
  ip?: string,
) {
  await recordAudit({
    actorId: staffId,
    action,
    entity,
    entityId,
    ...(after !== undefined && { after }),
    ...(ip && { ip }),
  });
}

// Featured cars -----------------------------------------------------------------------------------------------

async function choices(vehicles: VehicleRecord[]) {
  const live = await VehicleModel.find({
    _id: mongoose.trusted({ $in: vehicles.map((vehicle) => vehicle._id) }),
    ...liveVehicleFilter(),
  })
    .select('_id')
    .lean();
  return vehicles.map((vehicle) => ({
    id: vehicle._id.toString(),
    title: vehicleTitle(vehicle),
    ...(vehicle.city && { city: vehicle.city }),
    status: vehicle.status,
    live: live.some((candidate) => candidate._id.equals(vehicle._id)),
  }));
}

/** GET /admin/content/featured-vehicles: the cars picked for the homepage, in order. */
export async function featuredChoice() {
  const block = await CmsBlockModel.findOne({ key: FEATURED_BLOCK_KEY }).lean();
  const vehicleIds = ((block?.content as { vehicleIds?: string[] } | undefined)?.vehicleIds ?? []).filter(
    (id) => mongoose.isValidObjectId(id),
  );
  const vehicles = await VehicleModel.find({ _id: mongoose.trusted({ $in: vehicleIds }) }).lean<
    VehicleRecord[]
  >();
  vehicles.sort((a, b) => vehicleIds.indexOf(a._id.toString()) - vehicleIds.indexOf(b._id.toString()));
  return { vehicleIds, vehicles: await choices(vehicles) };
}

/** PUT /admin/content/featured-vehicles: up to eight cars, in order. None: the best-rated live cars. */
export async function setFeatured(staffId: string, vehicleIds: string[], ip?: string) {
  const unique = [...new Set(vehicleIds)];
  const found = await VehicleModel.countDocuments({ _id: mongoose.trusted({ $in: unique }) });
  if (found !== unique.length)
    throw new HttpError(400, 'UNKNOWN_VEHICLE', 'One of those cars doesn’t exist.');
  await CmsBlockModel.updateOne(
    { key: FEATURED_BLOCK_KEY },
    { $set: { content: { vehicleIds: unique } }, $setOnInsert: { version: '1' } },
    { upsert: true },
  );
  forget('vehicles:featured');
  await audit(
    staffId,
    'content.featured-vehicles',
    'cmsBlock',
    FEATURED_BLOCK_KEY,
    { vehicleIds: unique },
    ip,
  );
  return featuredChoice();
}

/** GET /admin/content/vehicles?q=: live cars to pick from, by make, model or town. */
export async function vehicleChoices(q?: string) {
  const pattern = q ? new RegExp(escape(q), 'i') : null;
  const vehicles = await VehicleModel.find({
    ...liveVehicleFilter(),
    ...(pattern && { $or: [{ make: pattern }, { model: pattern }, { city: pattern }] }),
  })
    .sort({ 'rating.avg': -1, tripCount: -1 })
    .limit(30)
    .lean<VehicleRecord[]>();
  return { vehicles: await choices(vehicles) };
}

// Legal pages -------------------------------------------------------------------------------------------------

const isLegalKey = (key: string): key is LegalKey => (LEGAL_PAGE_KEYS as readonly string[]).includes(key);

/** GET /admin/content/legal: every legal page. */
export async function legalPages() {
  const blocks = await CmsBlockModel.find({ key: mongoose.trusted({ $in: [...LEGAL_PAGE_KEYS] }) }).lean();
  return {
    pages: LEGAL_PAGE_KEYS.flatMap((key) => {
      const block = blocks.find((candidate) => candidate.key === key);
      if (!block) return [];
      const content = block.content as LegalContent;
      return [
        {
          key,
          version: block.version,
          title: content.title,
          markdown: content.markdown,
          updatedAt: block.updatedAt.toISOString(),
        },
      ];
    }),
  };
}

/**
 * PUT /admin/content/legal/{key}: corrects a legal page's wording. The version stays: a new version that
 * members accept again is published with a release (src/modules/users/agreements.ts, plan §6.1).
 */
export async function editLegalPage(
  staffId: string,
  key: string,
  input: z.infer<typeof legalPageEditSchema>,
  ip?: string,
) {
  if (!isLegalKey(key)) throw new HttpError(404, 'NOT_FOUND', 'No such page.');
  const block = await CmsBlockModel.findOne({ key });
  if (!block) throw new HttpError(404, 'NOT_FOUND', 'No such page.');
  block.content = { title: input.title, markdown: input.markdown } satisfies LegalContent;
  block.markModified('content');
  await block.save();
  await audit(
    staffId,
    'content.legal-edited',
    'cmsBlock',
    key,
    { title: input.title, version: block.version },
    ip,
  );
  const { pages } = await legalPages();
  return pages.find((page) => page.key === key)!;
}

// Destinations ------------------------------------------------------------------------------------------------

const destinationView = (destination: Destination) => {
  const [lng, lat] = destination.location.coordinates;
  return {
    slug: destination.slug,
    city: destination.city,
    ...(destination.maoriName && { maoriName: destination.maoriName }),
    region: destination.region,
    ...(destination.tagline && { tagline: destination.tagline }),
    intro: destination.intro,
    ...(destination.heroImage && { heroImage: destination.heroImage }),
    lat,
    lng,
    airports: destination.airports ?? [],
    featured: destination.featured === true,
    order: destination.order ?? 0,
    // Pages saved before `published` existed are published.
    published: destination.published !== false,
  };
};

const destinationSlugTaken = () =>
  new HttpError(409, 'SLUG_TAKEN', 'Another destination already uses that web address.');

/** Airport codes must be airports in our place list, which the page's airport search uses (plan §3). */
async function checkAirports(codes: string[] | undefined) {
  if (!codes?.length) return;
  const known = await PlaceModel.find({ type: 'AIRPORT', code: mongoose.trusted({ $in: codes }) })
    .select('code')
    .lean();
  const unknown = codes.filter((code) => !known.some((place) => place.code === code));
  if (unknown.length > 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      airports: `We don’t have ${unknown.length === 1 ? 'an airport' : 'airports'} with the code ${unknown.join(', ')}.`,
    });
  }
}

/** Every page lists an airport once, in the order typed. */
const uniqueCodes = (codes: string[] | undefined) => (codes ? [...new Set(codes)] : undefined);

/** GET /admin/content/destinations: every landing page, homepage tiles first, published or not. */
export async function listDestinations() {
  const destinations = await DestinationModel.find().sort({ featured: -1, order: 1, city: 1 }).lean();
  return { destinations: destinations.map(destinationView) };
}

/**
 * POST /admin/content/destinations: a new landing page, /rental/{slug} (plan §1.4: admins add destinations
 * without code changes). The web address can't change later, so links to it keep working.
 */
export async function createDestination(
  staffId: string,
  input: z.infer<typeof destinationCreateSchema>,
  ip?: string,
) {
  const airports = uniqueCodes(input.airports) ?? [];
  await checkAirports(airports);
  const { lat, lng, maoriName, tagline, heroImage, airports: _typed, ...fields } = input;
  try {
    const destination = await DestinationModel.create({
      ...fields,
      ...(maoriName && { maoriName }),
      ...(tagline && { tagline }),
      ...(heroImage && { heroImage }),
      airports,
      location: point(lng, lat),
    });
    forget('destinations');
    await audit(
      staffId,
      'content.destination-created',
      'destination',
      destination.slug,
      { city: destination.city, published: destination.published },
      ip,
    );
    return destinationView(destination.toObject());
  } catch (error) {
    if (isDuplicate(error)) throw destinationSlugTaken();
    throw error;
  }
}

/**
 * PATCH /admin/content/destinations/{slug}: a landing page's name, place, words, picture, airports, place on
 * the homepage, and whether it's published. Empty text removes an optional field. Unpublished, it's off the
 * homepage, its page answers 404 and the sitemap leaves it out.
 */
export async function editDestination(
  staffId: string,
  slug: string,
  input: z.infer<typeof destinationEditSchema>,
  ip?: string,
) {
  const airports = uniqueCodes(input.airports);
  await checkAirports(airports);
  const { lat, lng, maoriName, tagline, heroImage, airports: _typed, ...fields } = input;
  const set: Record<string, unknown> = { ...fields, ...(airports && { airports }) };
  const unset: Record<string, 1> = {};
  for (const [field, value] of Object.entries({ maoriName, tagline, heroImage })) {
    if (value === '') unset[field] = 1;
    else if (value !== undefined) set[field] = value;
  }
  if (lat !== undefined && lng !== undefined) set.location = point(lng, lat);
  const destination = await DestinationModel.findOneAndUpdate(
    { slug: slug.toLowerCase() },
    { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) },
    { new: true, runValidators: true },
  ).lean();
  if (!destination) throw new HttpError(404, 'NOT_FOUND', 'No such destination.');
  forget('destinations');
  await audit(staffId, 'content.destination-edited', 'destination', destination.slug, input, ip);
  return destinationView(destination);
}

// Homepage text and footer links (plan §12.6) -----------------------------------------------------------------

async function saveBlock(key: string, content: unknown) {
  await CmsBlockModel.updateOne(
    { key },
    { $set: { content }, $setOnInsert: { version: '1' } },
    { upsert: true },
  );
  forget(`cms:${key}`);
}

/** GET /admin/content/hero: the homepage's headline and supporting line, the original ones until saved. */
export async function heroText() {
  const { content, saved } = await homeHero();
  return { hero: content, saved };
}

/** PUT /admin/content/hero */
export async function setHeroText(staffId: string, hero: HomeHero, ip?: string) {
  await saveBlock(HERO_BLOCK_KEY, hero);
  await audit(staffId, 'content.hero-edited', 'cmsBlock', HERO_BLOCK_KEY, hero, ip);
  return heroText();
}

/** GET /admin/content/footer: the footer's groups of links and social accounts, the original ones until saved. */
export async function footerLinks() {
  const { content, saved } = await siteFooter();
  return { footer: content, saved };
}

/** PUT /admin/content/footer */
export async function setFooterLinks(staffId: string, footer: SiteFooter, ip?: string) {
  await saveBlock(FOOTER_BLOCK_KEY, footer);
  await audit(staffId, 'content.footer-edited', 'cmsBlock', FOOTER_BLOCK_KEY, footer, ip);
  return footerLinks();
}

// Customer reviews on the homepage (plan §12.6) ---------------------------------------------------------------

/** Reviews to pick from, as the homepage shows them, and whether each can show there now. */
async function reviewChoices(reviews: ReviewRecord[]) {
  const cards = await reviewCards(reviews);
  return reviews.map((review, index) => {
    const card = cards[index]!;
    return {
      id: card.id,
      authorName: card.author.firstName,
      overall: card.overall,
      body: card.body,
      vehicleTitle: card.vehicleTitle,
      ...(card.city && { city: card.city }),
      createdAt: card.createdAt,
      shown:
        review.direction === PUBLISHED_REVIEW.direction &&
        review.status === PUBLISHED_REVIEW.status &&
        review.moderation?.state === PUBLISHED_REVIEW['moderation.state'] &&
        Boolean(review.body?.trim()),
    };
  });
}

/**
 * GET /admin/content/featured-reviews: the reviews picked for the homepage, in order, with the threshold in
 * settings and how many reviews are published, since the section stays hidden until there are enough.
 */
export async function featuredReviewsChoice() {
  const [reviewIds, settings, publishedCount] = await Promise.all([
    pickedReviewIds(),
    getPlatformSettings(),
    ReviewModel.countDocuments(PUBLISHED_REVIEW),
  ]);
  const found = await ReviewModel.find({ _id: mongoose.trusted({ $in: reviewIds }) }).lean<ReviewRecord[]>();
  const reviews = reviewIds.flatMap((id) => found.filter((review) => review._id.equals(id)));
  return {
    reviewIds,
    reviews: await reviewChoices(reviews),
    homepageThreshold: settings.reviews.homepageThreshold,
    publishedCount,
  };
}

/**
 * PUT /admin/content/featured-reviews: up to six published reviews, in order. None: the homepage shows the
 * newest well-rated ones. One hidden later is left off the homepage.
 */
export async function setFeaturedReviews(staffId: string, reviewIds: string[], ip?: string) {
  const unique = [...new Set(reviewIds)];
  const found = await ReviewModel.countDocuments({
    _id: mongoose.trusted({ $in: unique }),
    ...quotableReview(),
  });
  if (found !== unique.length) {
    throw new HttpError(
      400,
      'UNKNOWN_REVIEW',
      'Only published Guest reviews with words to quote can show on the homepage.',
    );
  }
  await CmsBlockModel.updateOne(
    { key: FEATURED_REVIEWS_BLOCK_KEY },
    { $set: { content: { reviewIds: unique } }, $setOnInsert: { version: '1' } },
    { upsert: true },
  );
  forget('reviews:featured');
  await audit(
    staffId,
    'content.featured-reviews',
    'cmsBlock',
    FEATURED_REVIEWS_BLOCK_KEY,
    { reviewIds: unique },
    ip,
  );
  return featuredReviewsChoice();
}

/** GET /admin/content/reviews?q=: published Guest reviews with words to quote, newest first, by their text. */
export async function reviewChoicesFor(q?: string) {
  const reviews = await ReviewModel.find({
    ...quotableReview(),
    ...(q && { body: new RegExp(escape(q), 'i') }),
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean<ReviewRecord[]>();
  return { reviews: await reviewChoices(reviews) };
}

// FAQs --------------------------------------------------------------------------------------------------------

const faqView = (faq: Faq & { _id: Id }) => ({
  id: faq._id.toString(),
  question: faq.question,
  answer: faq.answer,
  category: faq.category,
  audience: faq.audience,
  showOnHome: faq.showOnHome,
  order: faq.order,
});

export async function listFaqs() {
  const faqs = await FaqModel.find().sort({ category: 1, order: 1, createdAt: 1 }).lean();
  return { faqs: faqs.map(faqView) };
}

export async function createFaq(staffId: string, input: z.infer<typeof faqInputSchema>, ip?: string) {
  const faq = await FaqModel.create(input);
  forget('faqs');
  await audit(staffId, 'content.faq-created', 'faq', faq.id, { question: input.question }, ip);
  return faqView(faq.toObject());
}

export async function updateFaq(
  staffId: string,
  id: string,
  input: z.infer<typeof faqInputSchema>,
  ip?: string,
) {
  const faq = mongoose.isValidObjectId(id)
    ? await FaqModel.findByIdAndUpdate(id, { $set: input }, { new: true, runValidators: true }).lean()
    : null;
  if (!faq) throw new HttpError(404, 'NOT_FOUND', 'No such question.');
  forget('faqs');
  await audit(staffId, 'content.faq-edited', 'faq', id, { question: input.question }, ip);
  return faqView(faq);
}

export async function deleteFaq(staffId: string, id: string, ip?: string) {
  const faq = mongoose.isValidObjectId(id) ? await FaqModel.findByIdAndDelete(id).lean() : null;
  if (!faq) throw new HttpError(404, 'NOT_FOUND', 'No such question.');
  forget('faqs');
  await audit(staffId, 'content.faq-deleted', 'faq', id, { question: faq.question }, ip);
}

// Help articles -----------------------------------------------------------------------------------------------

const articleView = (article: HelpArticle & { _id: Id }) => ({
  id: article._id.toString(),
  slug: article.slug,
  title: article.title,
  body: article.body,
  category: article.category,
  audience: article.audience,
  published: article.published,
  order: article.order,
  updatedAt: article.updatedAt.toISOString(),
});

const slugTaken = () => new HttpError(409, 'SLUG_TAKEN', 'Another article already uses that web address.');

export async function listHelpArticles() {
  const articles = await HelpArticleModel.find().sort({ category: 1, order: 1, title: 1 }).lean();
  return { articles: articles.map(articleView) };
}

export async function createHelpArticle(
  staffId: string,
  input: z.infer<typeof helpArticleInputSchema>,
  ip?: string,
) {
  try {
    const article = await HelpArticleModel.create(input);
    forget('help:articles');
    await audit(staffId, 'content.article-created', 'helpArticle', article.id, { slug: input.slug }, ip);
    return articleView(article.toObject());
  } catch (error) {
    if (isDuplicate(error)) throw slugTaken();
    throw error;
  }
}

export async function updateHelpArticle(
  staffId: string,
  id: string,
  input: z.infer<typeof helpArticleInputSchema>,
  ip?: string,
) {
  try {
    const article = mongoose.isValidObjectId(id)
      ? await HelpArticleModel.findByIdAndUpdate(
          id,
          { $set: input },
          { new: true, runValidators: true },
        ).lean()
      : null;
    if (!article) throw new HttpError(404, 'NOT_FOUND', 'No such article.');
    forget('help:articles');
    await audit(
      staffId,
      'content.article-edited',
      'helpArticle',
      id,
      { slug: input.slug, published: input.published },
      ip,
    );
    return articleView(article);
  } catch (error) {
    if (isDuplicate(error)) throw slugTaken();
    throw error;
  }
}

export async function deleteHelpArticle(staffId: string, id: string, ip?: string) {
  const article = mongoose.isValidObjectId(id) ? await HelpArticleModel.findByIdAndDelete(id).lean() : null;
  if (!article) throw new HttpError(404, 'NOT_FOUND', 'No such article.');
  forget('help:articles');
  await audit(staffId, 'content.article-deleted', 'helpArticle', id, { slug: article.slug }, ip);
}
