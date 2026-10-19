import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  moderateReviewSchema,
  moderationReviewSchema,
  myReviewsResponseSchema,
  publicProfileSchema,
  reviewInputSchema,
  reviewResponseSchema,
  submittedReviewResponseSchema,
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
      'The Guest reviews the Host and car (cleanliness), the Host reviews the Guest (care), once each, within the review window. Both are published together once both are in, or when the window closes; with the `revealTogether` setting off, each is published as soon as it’s written. With the `requireApproval` setting on (the default), every review waits for a moderator; otherwise only a review with contact details, links or abusive language does. `otherPublished` says whether the other side’s review is published now.',
    security: signedIn,
    request: { body: jsonBody(reviewInputSchema) },
    responses: {
      201: jsonResponse('Saved', submittedReviewResponseSchema),
      ...errorResponses(400, 401, 404, 409),
    },
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
    description:
      'Only what each party may see of the other (plan §6.2), and the reviews about them as Guest and as Host, without the booking each came from. Open to visitors. A closed or suspended account is not found.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonResponse('Profile and reviews', userReviewsResponseSchema),
      ...errorResponses(404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/users/{id}/profile',
    tags: ['Reviews'],
    summary: 'A member’s public profile',
    description:
      'The public profile of plan §11: only the fields of plan §6.2 (first name, photo, year joined, whether verified, ratings and trips as Guest and Host, and a Host’s bio and response rate), as GET /users/{id}/reviews gives it, without the reviews. Open to visitors. A closed or suspended account is not found.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonResponse(
        'Profile',
        z.object({ profile: publicProfileSchema }).meta({ id: 'UserProfileResponse' }),
      ),
      ...errorResponses(404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/reviews',
    tags: ['Admin'],
    summary: 'Staff: reviews held for moderation, published ones, or hidden ones',
    description:
      'HELD (the default) oldest first; PUBLISHED and HIDDEN newest first, 100 at most. A published review that breaks the rules can be hidden with a reason.',
    security: signedIn,
    request: { query: z.object({ state: z.enum(['HELD', 'PUBLISHED', 'HIDDEN']).optional() }) },
    responses: {
      200: jsonResponse(
        'Reviews',
        z.object({ reviews: z.array(moderationReviewSchema) }).meta({ id: 'ModerationReviews' }),
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
      // 409: another moderator changed it first.
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
