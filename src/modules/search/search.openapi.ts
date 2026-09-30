import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonResponse } from '../../openapi/shared.js';
import { BODY_TYPES, FUEL_TYPES, TRANSMISSIONS } from '../vehicles/vehicle.model.js';
import {
  SORTS,
  makesResponseSchema,
  placeDetailsSchema,
  placeSuggestionsResponseSchema,
  searchResponseSchema,
} from './search.schemas.js';

/**
 * GET /search's parameters as documented. The route's own parser (searchQuerySchema) is more
 * forgiving: an unknown value is ignored instead of failing the search (plan §3).
 */
const searchParameters = z.object({
  where: z
    .string()
    .optional()
    .meta({ description: 'Typed place, matched to our best place without coordinates' }),
  placeId: z.string().optional().meta({ description: 'A suggestion id from GET /places/suggest' }),
  lat: z.number().optional(),
  lng: z.number().optional(),
  airport: z
    .string()
    .optional()
    .meta({ description: 'IATA code: also finds cars that deliver to that airport' }),
  radiusKm: z.number().optional().meta({ description: 'Kept within the range in settings (GET /policies)' }),
  start: z
    .string()
    .optional()
    .meta({ description: 'Pick-up: "2026-10-12T10:00" in NZ time, or ISO 8601 with an offset' }),
  end: z.string().optional().meta({ description: 'Return, in the same format. Without dates: Browse Cars' }),
  minDailyCents: z.number().int().optional(),
  maxDailyCents: z.number().int().optional(),
  types: z.array(z.enum(BODY_TYPES)).optional().meta({ description: 'Repeat, or separate with commas' }),
  make: z.string().optional(),
  model: z.string().optional(),
  minYear: z.number().int().optional(),
  maxYear: z.number().int().optional(),
  transmission: z.enum(TRANSMISSIONS).optional(),
  minSeats: z.number().int().optional(),
  fuel: z.array(z.enum(FUEL_TYPES)).optional(),
  electrified: z.boolean().optional().meta({ description: 'Hybrid, plug-in hybrid or electric' }),
  airportDelivery: z.boolean().optional(),
  delivery: z.boolean().optional().meta({ description: 'Delivers to an address' }),
  instantBook: z.boolean().optional(),
  minRating: z.number().optional().meta({ description: '1–5; leaves out cars without reviews' }),
  unlimitedKm: z.boolean().optional(),
  petFriendly: z.boolean().optional(),
  childSeat: z.boolean().optional(),
  sort: z.enum(SORTS).optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional().meta({ description: 'Up to 48; 24 by default' }),
});

/** The contract for search.routes.ts (plan §2.3). */
export function registerSearchPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/search',
    tags: ['Search'],
    summary: 'Search Results and Browse Cars',
    description:
      'Public. Live cars matching every filter in spec §5, with their distance from the place. With dates, cars that are taken, need more notice, or whose documents expire are left out, and each card has an estimated total. With no place, the search covers all of NZ.',
    request: { query: searchParameters },
    responses: {
      200: jsonResponse('One page of results', searchResponseSchema),
      ...errorResponses(400),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/search/makes',
    tags: ['Search'],
    summary: 'Makes and models of live cars, for the filter',
    responses: { 200: jsonResponse('Makes and their models', makesResponseSchema) },
  });

  registry.registerPath({
    method: 'get',
    path: '/places/suggest',
    tags: ['Search'],
    summary: 'Location autocomplete (NZ only)',
    description:
      'Public. Our cities, suburbs, airports and destinations first ("taupo" finds Taupō, "akl" the airport), then street addresses from Google Places once it is set up. An empty `q` lists popular places.',
    request: {
      query: z.object({
        q: z.string().optional(),
        sessionToken: z
          .string()
          .optional()
          .meta({ description: 'One per search, passed again to GET /places/{id}, so Google bills it once' }),
      }),
    },
    responses: { 200: jsonResponse('Suggestions', placeSuggestionsResponseSchema), ...errorResponses(400) },
  });

  registry.registerPath({
    method: 'get',
    path: '/places/{id}',
    tags: ['Search'],
    summary: 'Coordinates and address of a suggestion',
    request: {
      params: z.object({ id: z.string().meta({ description: 'A suggestion id' }) }),
      query: z.object({ sessionToken: z.string().optional() }),
    },
    responses: {
      200: jsonResponse('The place', z.object({ place: placeDetailsSchema }).meta({ id: 'PlaceResponse' })),
      ...errorResponses(404),
    },
  });
}
