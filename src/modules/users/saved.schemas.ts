import { z } from 'zod';
import { vehicleCardSchema } from '../search/search.schemas.js';

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

export const savedCarSchema = vehicleCardSchema
  .extend({
    listed: z.boolean().meta({ description: 'Still live in search; false once the Host takes it down' }),
    availableForDates: z.boolean().nullable().meta({
      description:
        'Whether it can be booked for the last searched dates: free, documents current and within its trip rules. Null without dates',
    }),
  })
  .meta({
    id: 'SavedCar',
    description:
      'A car saved with the heart. The estimate is for the last searched dates, when it can be booked',
  });
export type SavedCar = z.infer<typeof savedCarSchema>;

export const savedCarsResponseSchema = z
  .object({
    cars: z.array(savedCarSchema).meta({ description: 'Most recently saved first' }),
    search: z
      .object({
        place: z.string().optional(),
        start: z.iso.datetime(),
        end: z.iso.datetime(),
        days: z.number().int(),
      })
      .nullable()
      .meta({ description: 'The last search’s dates, while they are still ahead; null otherwise' }),
  })
  .meta({ id: 'SavedCars' });
export type SavedCarsResponse = z.infer<typeof savedCarsResponseSchema>;
