import { z } from 'zod';
import { HOST_STATUSES } from '../users/user.model.js';
import { hostVehicleSchema } from '../vehicles/host-vehicles.schemas.js';
import { VEHICLE_STATUSES } from '../vehicles/vehicle.model.js';

/* The staff portal's basic approval queues (plan §9, Days 8–11). The full admin dashboard is Phase 3. */

export const hostApplicationSchema = z
  .object({
    userId: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    phone: z.string().optional(),
    phoneVerified: z.boolean(),
    identityStatus: z
      .enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED'])
      .meta({ description: 'The Host’s identity check (plan §9, Days 19–20)' }),
    status: z.enum(HOST_STATUSES),
    appliedAt: z.iso.datetime(),
    bio: z.string().optional(),
    gstRegistered: z.boolean(),
    gstNumber: z.string().optional(),
    reviewNotes: z.string().optional(),
    vehicles: z.object({ total: z.number().int(), underReview: z.number().int() }),
  })
  .meta({ id: 'HostApplication' });

export const hostApplicationsResponseSchema = z
  .object({ applications: z.array(hostApplicationSchema) })
  .meta({ id: 'HostApplications' });

export const reviewNotesSchema = z
  .object({ notes: z.string().trim().max(1000).optional() })
  .meta({ id: 'ReviewNotes' });

export const requiredNotesSchema = z
  .object({ notes: z.string().trim().min(3, { error: 'Tell the Host why' }).max(1000) })
  .meta({ id: 'RequiredReviewNotes' });

export const reviewQueueItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(VEHICLE_STATUSES),
    host: z.object({ id: z.string(), name: z.string(), status: z.enum(HOST_STATUSES).nullable() }),
    city: z.string().optional(),
    pendingPhotos: z.number().int(),
    pendingDocuments: z.number().int(),
    flags: z.number().int(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ReviewQueueItem' });

export const reviewQueueResponseSchema = z
  .object({ vehicles: z.array(reviewQueueItemSchema) })
  .meta({ id: 'ReviewQueue' });

export const adminVehicleSchema = z
  .object({
    vehicle: hostVehicleSchema,
    host: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      phone: z
        .string()
        .optional()
        .meta({ description: 'The verified mobile, to reach the Host about the listing' }),
      status: z.enum(HOST_STATUSES).nullable(),
      emailVerified: z.boolean(),
      phoneVerified: z.boolean(),
    }),
  })
  .meta({ id: 'AdminVehicle' });

export const photoDecisionSchema = z
  .object({ decision: z.enum(['APPROVE', 'REJECT']) })
  .meta({ id: 'PhotoDecision' });

export const documentDecisionSchema = z
  .object({ decision: z.enum(['VERIFY', 'REJECT']) })
  .meta({ id: 'DocumentDecision' });
