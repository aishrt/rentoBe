import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import { memo } from '../../lib/memo.js';
import type { Review } from '../reviews/review.model.js';
import { UserModel } from '../users/user.model.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import { vehicleTitle } from '../vehicles/vehicle-view.js';
import { CmsBlockModel } from './cms-block.model.js';
import { homeHeroSchema, siteFooterSchema, type HomeHero, type SiteFooter } from './content.schemas.js';

/*
 * The homepage text, footer links and customer reviews admins edit (plan §12.6, `cmsBlocks`). Each block
 * falls back to the website's original content while nothing is saved, so a missing or broken block never
 * breaks a page. Read through a one-minute cache per task (plan §4.1); an admin's save clears it.
 */

export const HERO_BLOCK_KEY = 'home.hero';
export const FOOTER_BLOCK_KEY = 'site.footer';
/** The customer reviews admins picked for the homepage, in order: `{ reviewIds }`. */
export const FEATURED_REVIEWS_BLOCK_KEY = 'home.featured-reviews';

/** The homepage shows up to six reviews. */
export const MAX_FEATURED_REVIEWS = 6;

const CACHE_MS = 60_000;

/** The headline and supporting line the homepage launched with (spec §4). */
export const DEFAULT_HERO: HomeHero = {
  headline: 'Rent a car from local owners across New Zealand.',
  subheading:
    'City runabouts, family SUVs and EVs for the long way round, booked in minutes from people who live here.',
};

/** The footer's links at launch. Social accounts are empty until the client supplies them (spec §4). */
export const DEFAULT_FOOTER: SiteFooter = {
  groups: [
    {
      title: 'Rent',
      links: [
        { label: 'Browse cars', href: '/cars' },
        { label: 'How it works', href: '/how-it-works' },
        { label: 'Safety', href: '/safety' },
        { label: 'Insurance & protection', href: '/insurance' },
      ],
    },
    {
      title: 'Host',
      links: [
        { label: 'Become a host', href: '/become-a-host' },
        { label: 'Host agreement', href: '/host-agreement' },
      ],
    },
    {
      title: 'Support',
      links: [
        { label: 'Help centre', href: '/help' },
        { label: 'FAQs', href: '/faq' },
        { label: 'Contact us', href: '/contact' },
        { label: 'About us', href: '/about' },
      ],
    },
    {
      title: 'Legal',
      links: [
        { label: 'Terms & conditions', href: '/terms' },
        { label: 'Privacy policy', href: '/privacy' },
        { label: 'Cancellation policy', href: '/cancellation-policy' },
        { label: 'Guest agreement', href: '/guest-agreement' },
      ],
    },
  ],
  socialLinks: [],
};

/** A block's content when it's saved and valid; otherwise the default. */
async function blockContent<T>(key: string, schema: z.ZodType<T>, fallback: T) {
  const block = await CmsBlockModel.findOne({ key }).lean();
  const parsed = block ? schema.safeParse(block.content) : null;
  return parsed?.success ? { content: parsed.data, saved: true } : { content: fallback, saved: false };
}

/** The homepage's headline and supporting line, and whether an admin has saved their own. */
export const homeHero = () =>
  memo(`cms:${HERO_BLOCK_KEY}`, CACHE_MS, () => blockContent(HERO_BLOCK_KEY, homeHeroSchema, DEFAULT_HERO));

/** The footer's groups of links and social accounts, and whether an admin has saved their own. */
export const siteFooter = () =>
  memo(`cms:${FOOTER_BLOCK_KEY}`, CACHE_MS, () =>
    blockContent(FOOTER_BLOCK_KEY, siteFooterSchema, DEFAULT_FOOTER),
  );

// Customer reviews -------------------------------------------------------------------------------------------

type ReviewRecord = Review & { _id: Types.ObjectId };

/** A Guest's review of a trip, published and not hidden: the only kind the homepage shows (plan §12.6). */
export const PUBLISHED_REVIEW = {
  direction: 'GUEST_TO_HOST',
  status: 'PUBLISHED',
  'moderation.state': 'CLEAR',
} as const;

/** …with words to quote. */
export const quotableReview = () => ({
  ...PUBLISHED_REVIEW,
  body: mongoose.trusted({ $type: 'string', $ne: '' }),
});

/** The review ids admins picked, in order (none: the homepage chooses). */
export async function pickedReviewIds(): Promise<string[]> {
  const block = await CmsBlockModel.findOne({ key: FEATURED_REVIEWS_BLOCK_KEY }).lean();
  const ids = (block?.content as { reviewIds?: unknown } | undefined)?.reviewIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && mongoose.isValidObjectId(id))
    : [];
}

/** Reviews as the homepage shows them: the author's first name, the car and its town. */
export async function reviewCards(reviews: ReviewRecord[]) {
  const [authors, vehicles] = await Promise.all([
    UserModel.find({ _id: mongoose.trusted({ $in: reviews.map((review) => review.authorId) }) })
      .select('firstName avatarUrl')
      .lean(),
    VehicleModel.find({
      _id: mongoose.trusted({
        $in: reviews.flatMap((review) => (review.vehicleId ? [review.vehicleId] : [])),
      }),
    })
      .select('year make model city')
      .lean(),
  ]);
  return reviews.map((review) => {
    const author = authors.find((candidate) => candidate._id.equals(review.authorId));
    const vehicle = vehicles.find((candidate) => review.vehicleId && candidate._id.equals(review.vehicleId));
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
  });
}
