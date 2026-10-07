import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  availabilityResponseSchema,
  featuredVehiclesSchema,
  quoteRequestSchema,
  quoteSchema,
  vehicleDetailSchema,
  vehicleReviewsResponseSchema,
} from './vehicles.schemas.js';

const idParam = z.object({ id: z.string().meta({ description: 'The car’s id' }) });

/** The contract for vehicles.routes.ts (plan §2.3). */
export function registerVehiclePaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/vehicles/featured',
    tags: ['Vehicles'],
    summary: 'The homepage’s featured cars',
    description: 'Public. The cars admins picked, or else the best-rated live cars.',
    responses: { 200: jsonResponse('Up to 8 cars', featuredVehiclesSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/vehicles/{slug}',
    tags: ['Vehicles'],
    summary: 'A live listing',
    description:
      'Public. Approved photos, specs, rego and WOF status, policies, delivery options and the Host. Never the plate or the exact address. 404 for anything not live.',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: jsonResponse(
        'The listing',
        z.object({ vehicle: vehicleDetailSchema }).meta({ id: 'VehicleResponse' }),
      ),
      ...errorResponses(404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/vehicles/{id}/availability',
    tags: ['Vehicles'],
    summary: 'When the car is taken',
    description: 'Public. Busy times between `from` and `to` (6 months by default), merged, never why.',
    request: {
      params: idParam,
      query: z.object({
        from: z.string().optional().meta({ description: 'YYYY-MM-DD or a date and time; now by default' }),
        to: z.string().optional(),
      }),
    },
    responses: { 200: jsonResponse('Busy times', availabilityResponseSchema), ...errorResponses(404) },
  });

  registry.registerPath({
    method: 'get',
    path: '/vehicles/{id}/area-map',
    tags: ['Vehicles'],
    summary: 'The listing’s area map',
    description:
      'Public. A Maps Static API image of the approximate area as a shaded circle, never a pin, fetched with the server’s Google key so no key reaches the browser. Use the listing’s `location.mapUrl`. Cached for a day.',
    request: {
      params: idParam,
      query: z.object({
        v: z.string().optional().meta({ description: 'Changes when the area moves, so caches refresh' }),
      }),
    },
    responses: {
      200: {
        description: 'The map',
        content: { 'image/png': { schema: z.string().meta({ format: 'binary' }) } },
      },
      ...errorResponses(404, 429, 503),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/vehicles/{id}/reviews',
    tags: ['Vehicles'],
    summary: 'Published guest reviews of the car',
    request: { params: idParam, query: z.object({ page: z.number().int().optional() }) },
    responses: {
      200: jsonResponse('10 reviews a page', vehicleReviewsResponseSchema),
      ...errorResponses(404),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/vehicles/{id}/quote',
    tags: ['Vehicles'],
    summary: 'Price a trip',
    description:
      'Public. The price breakdown in NZD for the dates, pick-up and return options and protection plan, and every problem in the way (dates taken, notice, trip length, documents, delivery area). Holds nothing.',
    request: { params: idParam, body: jsonBody(quoteRequestSchema) },
    responses: {
      200: jsonResponse('The quote', z.object({ quote: quoteSchema }).meta({ id: 'QuoteResponse' })),
      ...errorResponses(400, 404),
    },
  });
}
