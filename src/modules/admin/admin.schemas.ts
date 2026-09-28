import { z } from 'zod';

/** A count, or null while the module that owns its data isn't built yet. */
const pendingMetric = z.number().int().nullable();

/**
 * KPI figures for the admin overview (spec §18). A metric is `null` until the module that owns its
 * data exists (vehicles, bookings, payments, verification), so the dashboard never shows a made-up zero.
 */
export const adminOverviewSchema = z
  .object({
    metrics: z.object({
      totalUsers: z.number().int(),
      activeHosts: z.number().int(),
      staffMembers: z.number().int(),
      suspendedUsers: z.number().int(),
      activeVehicles: pendingMetric,
      upcomingBookings: pendingMetric,
      bookingRevenueCents: pendingMetric,
      pendingVerifications: pendingMetric,
    }),
    generatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminOverview' });

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
