import { z } from 'zod';
import { MODERATION_STATES, REVIEW_DIRECTIONS, REVIEW_STATUSES } from './review.model.js';

/* Two-way reviews and ratings (spec §16, plan §9 Days 21–22). */

const stars = (label: string) =>
  z
    .number({ error: `Rate the ${label}` })
    .int({ error: 'Choose whole stars' })
    .min(1, { error: `Rate the ${label}` })
    .max(5);

export const reviewInputSchema = z
  .object({
    bookingRef: z.string().regex(/^RV-[A-Za-z0-9]{6}$/, { error: 'Booking references look like RV-7K2Q9M' }),
    overall: stars('trip overall'),
    communication: stars('communication'),
    pickupReturn: stars('pick-up and return'),
    cleanliness: stars('car’s cleanliness and condition')
      .optional()
      .meta({ description: 'Guest → Host: the car’s cleanliness and condition' }),
    care: stars('care of the car')
      .optional()
      .meta({ description: 'Host → Guest: care of the car and behaviour' }),
    body: z.string().trim().max(1000, { error: 'Reviews can be up to 1,000 characters' }).optional(),
  })
  .meta({ id: 'ReviewRequest' });
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const reviewViewSchema = z
  .object({
    id: z.string(),
    bookingRef: z.string(),
    direction: z.enum(REVIEW_DIRECTIONS),
    author: z.object({ id: z.string(), firstName: z.string(), avatarUrl: z.string().optional() }),
    subject: z.object({ id: z.string(), firstName: z.string() }),
    vehicleTitle: z.string(),
    overall: z.number().int(),
    communication: z.number().int().optional(),
    pickupReturn: z.number().int().optional(),
    cleanliness: z.number().int().optional(),
    care: z.number().int().optional(),
    body: z.string().optional(),
    status: z.enum(REVIEW_STATUSES),
    moderation: z
      .enum(MODERATION_STATES)
      .optional()
      .meta({ description: 'The author’s and staff’s view only' }),
    revealAt: z.iso.datetime().optional().meta({ description: 'Waiting: when it’s published at the latest' }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Review' });
export type ReviewView = z.infer<typeof reviewViewSchema>;

export const reviewToWriteSchema = z
  .object({
    bookingRef: z.string(),
    role: z.enum(['GUEST', 'HOST']).meta({ description: 'You review the other side' }),
    otherParty: z.object({ firstName: z.string(), avatarUrl: z.string().optional() }),
    vehicleTitle: z.string(),
    end: z.iso.datetime(),
    closesAt: z.iso.datetime().meta({ description: 'The last moment to write it' }),
  })
  .meta({ id: 'ReviewToWrite' });

export const myReviewsResponseSchema = z
  .object({
    toWrite: z.array(reviewToWriteSchema),
    written: z.array(reviewViewSchema),
    received: z.array(reviewViewSchema).meta({ description: 'Published reviews about you' }),
  })
  .meta({ id: 'MyReviews' });

export const reviewResponseSchema = z.object({ review: reviewViewSchema }).meta({ id: 'ReviewResponse' });

export const publicProfileSchema = z
  .object({
    id: z.string(),
    firstName: z.string(),
    avatarUrl: z.string().optional(),
    joinedYear: z.number().int(),
    verified: z.boolean(),
    asGuest: z.object({
      rating: z.object({ avg: z.number(), count: z.number().int() }),
      tripCount: z.number().int(),
    }),
    asHost: z
      .object({
        rating: z.object({ avg: z.number(), count: z.number().int() }),
        tripCount: z.number().int(),
        responseRate: z.number().int().optional(),
        bio: z.string().optional(),
      })
      .optional(),
  })
  .meta({ id: 'PublicProfile' });

export const userReviewsResponseSchema = z
  .object({ profile: publicProfileSchema, reviews: z.array(reviewViewSchema) })
  .meta({ id: 'UserReviews' });

export const moderateReviewSchema = z
  .object({
    action: z.enum(['CLEAR', 'HIDE']),
    reason: z.string().trim().min(3, { error: 'Say why' }).max(500),
  })
  .meta({ id: 'ModerateReviewRequest' });
