import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { helpArticleResponseSchema, helpArticlesResponseSchema } from '../help/help.schemas.js';
import {
  contactRequestSchema,
  contactResponseSchema,
  supportTicketResponseSchema,
  supportTicketsResponseSchema,
  ticketReplySchema,
} from '../support/support.schemas.js';
import {
  LEGAL_PAGE_KEYS,
  destinationDetailSchema,
  destinationsResponseSchema,
  faqsResponseSchema,
  featuredReviewsResponseSchema,
  homeHeroSchema,
  legalPageSchema,
  publicPoliciesSchema,
  siteFooterSchema,
} from './content.schemas.js';
import { FOOTER_BLOCK_KEY, HERO_BLOCK_KEY } from './site-content.js';

/** The contract for content.routes.ts, help.routes.ts and support.routes.ts (plan §2.3). */
export function registerContentPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/destinations',
    tags: ['Content'],
    summary: 'City and destination landing pages',
    description: 'Public. Published ones only, featured first: they are the homepage tiles.',
    responses: { 200: jsonResponse('Destinations', destinationsResponseSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/destinations/{slug}',
    tags: ['Content'],
    summary: 'One destination, for /rental/{slug}',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: jsonResponse(
        'The destination',
        z.object({ destination: destinationDetailSchema }).meta({ id: 'DestinationResponse' }),
      ),
      ...errorResponses(404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/cms/{key}',
    tags: ['Content'],
    summary: 'A legal page in Markdown',
    description: 'Public. The legal pages are placeholders until the client’s legal adviser supplies them.',
    request: { params: z.object({ key: z.enum(LEGAL_PAGE_KEYS) }) },
    responses: {
      200: jsonResponse('The page', z.object({ page: legalPageSchema }).meta({ id: 'LegalPageResponse' })),
      ...errorResponses(404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: `/cms/${HERO_BLOCK_KEY}`,
    tags: ['Content'],
    summary: 'The homepage’s headline and supporting line',
    description: 'Public. The original text until an admin saves their own.',
    responses: {
      200: jsonResponse('The text', z.object({ hero: homeHeroSchema }).meta({ id: 'HomeHeroResponse' })),
    },
  });

  registry.registerPath({
    method: 'get',
    path: `/cms/${FOOTER_BLOCK_KEY}`,
    tags: ['Content'],
    summary: 'The footer’s links and social accounts',
    description: 'Public. The original links until an admin saves their own.',
    responses: {
      200: jsonResponse(
        'The links',
        z.object({ footer: siteFooterSchema }).meta({ id: 'SiteFooterResponse' }),
      ),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/faqs',
    tags: ['Content'],
    summary: 'Frequently asked questions',
    request: {
      query: z.object({
        audience: z
          .enum(['GUEST', 'HOST'])
          .optional()
          .meta({ description: 'Also includes questions for everyone' }),
        home: z.boolean().optional().meta({ description: 'Only the homepage’s questions' }),
      }),
    },
    responses: { 200: jsonResponse('Questions in order', faqsResponseSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/policies',
    tags: ['Content'],
    summary: 'Fees, cancellation tiers, protection plans and listing rules',
    description:
      'Public. The settings in force that the website shows: the Cancellation Policy and Insurance pages, the Become a Host estimator, checkout and Host onboarding.',
    responses: { 200: jsonResponse('The policies', publicPoliciesSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/reviews/featured',
    tags: ['Content'],
    summary: 'Customer reviews for the homepage',
    description:
      'Public. Real published reviews only, and `show: false` until there are enough (settings). The ones admins picked, in order, or else the newest well-rated ones.',
    responses: { 200: jsonResponse('Reviews', featuredReviewsResponseSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/support/tickets',
    tags: ['Content'],
    summary: 'Contact Us',
    description:
      'Works signed out. Creates a support ticket and emails its reference to the sender. Rate-limited per IP.',
    request: { body: jsonBody(contactRequestSchema) },
    responses: {
      201: jsonResponse('The ticket', contactResponseSchema),
      ...errorResponses(400, 429),
    },
  });

  const refParam = z.object({
    ref: z.string().meta({ description: 'The ticket reference, e.g. ST-4HX8PA' }),
  });

  registry.registerPath({
    method: 'get',
    path: '/support/tickets',
    tags: ['Content'],
    summary: 'My support requests',
    description:
      'The signed-in user’s own tickets, most recently active first: from the Contact form while signed in, a booking’s Contact support link or a privacy request.',
    security: signedIn,
    responses: { 200: jsonResponse('Tickets', supportTicketsResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/support/tickets/{ref}',
    tags: ['Content'],
    summary: 'One of my support requests, with its replies',
    description: 'The staff’s internal notes are never included.',
    security: signedIn,
    request: { params: refParam },
    responses: {
      200: jsonResponse('The ticket', supportTicketResponseSchema),
      ...errorResponses(401, 404),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/support/tickets/{ref}/messages',
    tags: ['Content'],
    summary: 'Reply on my support request',
    description: 'It goes back to the support team, reopening a resolved ticket. Rate-limited per user.',
    security: signedIn,
    request: { params: refParam, body: jsonBody(ticketReplySchema) },
    responses: {
      200: jsonResponse('The ticket', supportTicketResponseSchema),
      ...errorResponses(400, 401, 404, 429),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/help/articles',
    tags: ['Content'],
    summary: 'Help centre articles',
    description:
      'Public. Published articles in the order admins set; with an audience, the ones for Guests or Hosts and the ones for everyone.',
    request: {
      query: z.object({
        audience: z
          .enum(['GUEST', 'HOST'])
          .optional()
          .meta({ description: 'Also includes the articles for everyone' }),
      }),
    },
    responses: { 200: jsonResponse('Articles', helpArticlesResponseSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/help/articles/{slug}',
    tags: ['Content'],
    summary: 'One help article',
    request: { params: z.object({ slug: z.string() }) },
    responses: { 200: jsonResponse('The article', helpArticleResponseSchema), ...errorResponses(404) },
  });
}
