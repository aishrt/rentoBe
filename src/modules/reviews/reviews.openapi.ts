import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  moderateReviewSchema,
  myReviewsResponseSchema,
  reviewInputSchema,
  reviewResponseSchema,
  reviewViewSchema,
  userReviewsResponseSchema,
} from './reviews.schemas.js';

/** The contract for writing, reading and moderating reviews (plan §2.3, spec §16). */
export function registerReviewPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'post',
    path: '/reviews',
    tags: ['Reviews'],
    summary: 'Review a completed trip',
    description:
      'The Guest reviews the Host and car (cleanliness), the Host reviews the Guest (care), once each, within the review window. Both are published together once both are in, or when the window closes. A review with contact details, links or abusive language waits for a moderator.',
    security: signedIn,
    request: { body: jsonBody(reviewInputSchema) },
    responses: { 201: jsonResponse('Saved', reviewResponseSchema), ...errorResponses(400, 401, 404, 409) },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/reviews',
    tags: ['Reviews'],
    summary: 'Reviews to write, written and received',
    security: signedIn,
    responses: { 200: jsonResponse('Reviews', myReviewsResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/users/{id}/reviews',
    tags: ['Reviews'],
    summary: 'A member’s public profile and the published reviews about them',
    description: 'Only what each party may see of the other (plan §6.2).',
    security: signedIn,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonResponse('Profile and reviews', userReviewsResponseSchema),
      ...errorResponses(401, 404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/reviews',
    tags: ['Admin'],
    summary: 'Staff: reviews held for moderation, or hidden ones',
    security: signedIn,
    request: { query: z.object({ state: z.enum(['HELD', 'HIDDEN']).optional() }) },
    responses: {
      200: jsonResponse(
        'Reviews',
        z
          .object({ reviews: z.array(reviewViewSchema.extend({ moderationReason: z.string() })) })
          .meta({ id: 'ModerationReviews' }),
      ),
      ...errorResponses(401, 403),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/reviews/{id}/moderate',
    tags: ['Admin'],
    summary: 'Staff: clear a held review, or hide one with a reason',
    security: signedIn,
    request: { params: z.object({ id: z.string() }), body: jsonBody(moderateReviewSchema) },
    responses: {
      200: jsonResponse('Moderated', reviewResponseSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });
}
