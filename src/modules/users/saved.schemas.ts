import { z } from 'zod';

export const favouritesResponseSchema = z
  .object({ vehicleIds: z.array(z.string()).meta({ description: 'Saved cars, most recent first' }) })
  .meta({ id: 'Favourites' });

export const lastSearchSchema = z
  .object({
    place: z.string().trim().max(100).optional(),
    lat: z.number().min(-48).max(-33).optional(),
    lng: z.number().min(165).max(179.9).optional(),
    start: z.string().max(40).optional().meta({ description: '"2026-10-12T10:00" in NZ time' }),
    end: z.string().max(40).optional(),
  })
  .meta({ id: 'LastSearch' });
export type LastSearchInput = z.infer<typeof lastSearchSchema>;
