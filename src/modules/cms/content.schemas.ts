import { z } from 'zod';
import { cancellationTierSchema, protectionPlanSchema } from '../admin/platform-settings.schemas.js';
import { AUDIENCES } from '../help/help-article.model.js';
import { LICENCE_CLASSES } from '../users/user.model.js';
import { BODY_TYPES, DOCUMENT_TYPES, PHOTO_TYPES } from '../vehicles/vehicle.model.js';

/* Public content for the website's pages (plan §9, Days 12–14, and the homepage, Days 7–9). */

export const destinationSummarySchema = z
  .object({
    slug: z.string(),
    city: z.string(),
    maoriName: z.string().optional(),
    region: z.string(),
    tagline: z.string().optional(),
    heroImage: z.string().optional(),
    lat: z.number(),
    lng: z.number(),
    airports: z.array(z.string()).meta({ description: 'IATA codes of the airports that serve it' }),
    featured: z.boolean().meta({ description: 'A homepage tile' }),
  })
  .meta({ id: 'DestinationSummary' });

export const destinationDetailSchema = destinationSummarySchema
  .extend({ intro: z.string() })
  .meta({ id: 'DestinationDetail' });

export const destinationsResponseSchema = z
  .object({ destinations: z.array(destinationSummarySchema) })
  .meta({ id: 'Destinations' });

export const LEGAL_PAGE_KEYS = [
  'legal.terms',
  'legal.privacy',
  'legal.cancellation-policy',
  'legal.host-agreement',
  'legal.guest-agreement',
] as const;

export const legalPageSchema = z
  .object({
    key: z.enum(LEGAL_PAGE_KEYS),
    version: z.string().meta({ description: 'The document version users accept' }),
    title: z.string(),
    markdown: z.string().meta({ description: 'The document in Markdown' }),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'LegalPage' });

export const faqSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    answer: z.string(),
    category: z.string(),
    audience: z.enum(AUDIENCES),
  })
  .meta({ id: 'Faq' });

export const faqsQuerySchema = z.object({
  audience: z.enum(['GUEST', 'HOST']).optional().catch(undefined),
  home: z
    .preprocess((value) => value === 'true' || value === '1', z.boolean())
    .optional()
    .catch(undefined),
});

export const faqsResponseSchema = z.object({ faqs: z.array(faqSchema) }).meta({ id: 'Faqs' });

/** The settings the public pages, checkout and Host onboarding show (never staff-only ones). */
export const publicPoliciesSchema = z
  .object({
    fees: z.object({
      guestServiceFeePct: z.number(),
      hostCommissionPct: z.number(),
      gstRatePct: z.number(),
    }),
    cancellation: z.object({
      tiers: z.array(cancellationTierSchema),
      hostSelectableTiers: z.array(z.string()),
      defaultTier: z.string(),
      hostCancellationFeeCents: z.number().int(),
    }),
    protectionPlans: z.array(protectionPlanSchema),
    roadsideAssistance: z.object({
      phone: z.string().meta({ description: "The insurance partner's number; empty until it's set" }),
    }),
    eligibility: z.object({
      minAge: z.number().int(),
      minYearsLicensed: z.number(),
      acceptedLicenceClasses: z.array(z.enum(LICENCE_CLASSES)),
      overseasNeedsEnglishProof: z.boolean(),
    }),
    vehicles: z.object({
      requiredDocuments: z.array(z.enum(DOCUMENT_TYPES)),
      requiredPhotoAngles: z.array(z.enum(PHOTO_TYPES)),
      vinOrChassisRequired: z.boolean(),
      minPhotoWidthPx: z.number().int(),
      minPhotoHeightPx: z.number().int(),
      seats: z.object({ min: z.number().int(), max: z.number().int() }),
      doors: z.object({ min: z.number().int(), max: z.number().int() }),
      dailyPriceCents: z.object({ min: z.number().int(), max: z.number().int() }),
      maxDiscountPct: z.number(),
    }),
    search: z.object({
      maxTripDays: z.number().int(),
      radiusKm: z.object({ min: z.number(), default: z.number(), max: z.number() }),
    }),
    hostEstimator: z.object({
      bookedDaysPerMonth: z.number().int(),
      dailyCentsByBodyType: z.record(z.enum(BODY_TYPES), z.number().int()),
    }),
    reviews: z.object({ windowDays: z.number().int() }),
    trips: z.object({ lateReturnGraceMinutes: z.number().int() }),
  })
  .meta({ id: 'PublicPolicies' });
export type PublicPolicies = z.infer<typeof publicPoliciesSchema>;

export const featuredReviewSchema = z
  .object({
    id: z.string(),
    author: z.object({ firstName: z.string(), avatarUrl: z.string().optional() }),
    overall: z.number().int(),
    body: z.string(),
    vehicleTitle: z.string(),
    city: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'FeaturedReview' });

export const featuredReviewsResponseSchema = z
  .object({
    show: z.boolean().meta({
      description:
        'False until the published reviews reach the homepage threshold in settings: hide the section',
    }),
    reviews: z.array(featuredReviewSchema),
  })
  .meta({ id: 'FeaturedReviews' });

// Homepage text and footer links (plan §12.6) -----------------------------------------------------------------

const isHttps = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
};
/**
 * A path on this website, like /help or /faq#booking. Never two slashes or a backslash after the first,
 * which browsers read as another website's address.
 */
const isSitePath = (value: string) => /^\/(?![/\\])[^\s\\]*$/.test(value);

/** A full https:// address, or a path on this website. */
export const isLinkAddress = (value: string) => isHttps(value) || isSitePath(value);

/** A full https:// address. */
export const httpsAddress = z
  .string()
  .trim()
  .max(500, { error: 'Use 500 characters or fewer' })
  .refine(isHttps, { error: 'Use a full address starting with https://' });

/** A full https:// address, or a path on this website such as /help. */
export const linkAddress = z
  .string()
  .trim()
  .max(500, { error: 'Use 500 characters or fewer' })
  .refine(isLinkAddress, {
    error: 'Use a full address starting with https://, or a path on this website starting with /',
  });

export const homeHeroSchema = z
  .object({
    headline: z
      .string()
      .trim()
      .min(10, { error: 'Write at least 10 characters' })
      .max(100, { error: 'Use 100 characters or fewer' }),
    subheading: z
      .string()
      .trim()
      .min(10, { error: 'Write at least 10 characters' })
      .max(300, { error: 'Use 300 characters or fewer' })
      .meta({ description: 'The supporting line under the headline' }),
  })
  .meta({ id: 'HomeHero' });
export type HomeHero = z.infer<typeof homeHeroSchema>;

const linkLabel = z
  .string()
  .trim()
  .min(1, { error: 'Give the link a name' })
  .max(40, { error: 'Use 40 characters or fewer' });

export const footerLinkSchema = z.object({ label: linkLabel, href: linkAddress }).meta({ id: 'FooterLink' });

export const socialLinkSchema = z
  .object({ label: linkLabel, href: httpsAddress })
  .meta({ id: 'SocialLink', description: 'A social media account, e.g. Instagram' });

export const footerGroupSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, { error: 'Give the group a heading' })
      .max(30, { error: 'Use 30 characters or fewer' }),
    links: z.array(footerLinkSchema).max(8, { error: 'Up to 8 links in a group' }),
  })
  .meta({ id: 'FooterGroup' });

export const siteFooterSchema = z
  .object({
    groups: z
      .array(footerGroupSchema)
      .min(1, { error: 'Keep at least one group' })
      .max(4, { error: 'Up to 4 groups' })
      .meta({ description: 'The footer’s columns of links; a group with no links is left out' }),
    socialLinks: z.array(socialLinkSchema).max(6, { error: 'Up to 6 social links' }),
  })
  .meta({ id: 'SiteFooter' });
export type SiteFooter = z.infer<typeof siteFooterSchema>;
