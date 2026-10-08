import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { recordAudit } from '../audit/audit.service.js';
import { CmsBlockModel, type LegalContent } from '../cms/cms-block.model.js';
import { LEGAL_PAGE_KEYS } from '../cms/content.schemas.js';
import { DestinationModel, type Destination } from '../cms/destination.model.js';
import { FaqModel, type Faq } from '../help/faq.model.js';
import { HelpArticleModel, type HelpArticle } from '../help/help-article.model.js';
import { FEATURED_BLOCK_KEY } from '../vehicles/vehicles.service.js';
import { liveVehicleFilter, VehicleModel, type Vehicle } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import type {
  destinationEditSchema,
  faqInputSchema,
  helpArticleInputSchema,
  legalPageEditSchema,
} from './admin-ops.schemas.js';

/*
 * Content in the staff portal (spec §18; plan §9 Days 19–23), admin only: the homepage's featured cars,
 * the legal pages, destination landing pages, FAQs (and which show on the homepage) and help articles.
 * Public pages cache content for a minute; a change clears that cache at once on this task.
 */

type Id = Types.ObjectId;
type VehicleRecord = Vehicle & { _id: Id };
type LegalKey = (typeof LEGAL_PAGE_KEYS)[number];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const destinationView = (destination: Destination) => ({
  slug: destination.slug,
  city: destination.city,
  ...(destination.maoriName && { maoriName: destination.maoriName }),
  region: destination.region,
  ...(destination.tagline && { tagline: destination.tagline }),
  intro: destination.intro,
  ...(destination.heroImage && { heroImage: destination.heroImage }),
  featured: destination.featured,
  order: destination.order,
});

/** GET /admin/content/destinations: every landing page, homepage tiles first. */
export async function listDestinations() {
  const destinations = await DestinationModel.find().sort({ featured: -1, order: 1, city: 1 }).lean();
  return { destinations: destinations.map(destinationView) };
}

/** PATCH /admin/content/destinations/{slug}: a landing page's words, picture, and place on the homepage. */
export async function editDestination(
  staffId: string,
  slug: string,
  input: z.infer<typeof destinationEditSchema>,
  ip?: string,
) {
  const destination = await DestinationModel.findOneAndUpdate(
    { slug: slug.toLowerCase() },
    { $set: input },
    { new: true, runValidators: true },
  ).lean();
  if (!destination) throw new HttpError(404, 'NOT_FOUND', 'No such destination.');
  forget('destinations');
  await audit(staffId, 'content.destination-edited', 'destination', destination.slug, input, ip);
  return destinationView(destination);
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
const isDuplicate = (error: unknown) =>
  error instanceof mongoose.mongo.MongoServerError && error.code === 11000;

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
