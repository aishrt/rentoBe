import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { contactRequestSchema, contactResponseSchema } from '../support/support.schemas.js';
import {
  LEGAL_PAGE_KEYS,
  destinationDetailSchema,
  destinationsResponseSchema,
  faqsResponseSchema,
  featuredReviewsResponseSchema,
  legalPageSchema,
  publicPoliciesSchema,
} from './content.schemas.js';

/** The contract for content.routes.ts and support.routes.ts (plan §2.3). */
export function registerContentPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/destinations',
    tags: ['Content'],
    summary: 'City and destination landing pages',
    description: 'Public. Featured ones first: they are the homepage tiles.',
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
    description: 'Public. Real published reviews only, and `show: false` until there are enough (settings).',
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
}
