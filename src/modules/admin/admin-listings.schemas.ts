import { z } from 'zod';
import { HOST_STATUSES } from '../users/user.model.js';
import { hostVehicleSchema } from '../vehicles/host-vehicles.schemas.js';
import { VEHICLE_STATUSES } from '../vehicles/vehicle.model.js';
import { bookingRowSchema } from './admin-ops.schemas.js';

/* The staff portal's approval queues (plan §9, Days 8–11): Host applications and listings. */

/** The details that send a live listing back for review when its Host changes them (plan §3). */
const KEY_DETAILS = ['regoPlate', 'vin', 'chassisNo', 'make', 'model', 'year'] as const;

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
    identityRequired: z.boolean().meta({
      description:
        'Whether approval waits for a passed identity check (the identityForHosts platform setting)',
    }),
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
    keyChanges: z.array(z.enum(KEY_DETAILS)).meta({
      description: 'Key details the Host changed on the live listing, which sent it back for review',
    }),
    flags: z.number().int(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ReviewQueueItem' });

export const reviewQueueResponseSchema = z
  .object({ vehicles: z.array(reviewQueueItemSchema) })
  .meta({ id: 'ReviewQueue' });

/** GET /admin/vehicles/search: every car, not only those waiting for review (plan §12.6). */
export const vehicleListQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .meta({ description: 'Words to match: the year, make or model, the plate, or the Host’s name or email' }),
  status: z.enum(VEHICLE_STATUSES).optional(),
  hostId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, { error: 'Not a user id' })
    .optional()
    .meta({ description: 'Only this Host’s cars' }),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

export const adminVehicleRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(VEHICLE_STATUSES),
    regoPlate: z.string().optional(),
    city: z.string().optional(),
    host: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    waitingForPayouts: z
      .boolean()
      .meta({ description: 'Approved, but hidden until the Host finishes payout setup (plan §8.2)' }),
    hostSuspended: z
      .boolean()
      .meta({ description: 'Hidden while its Host’s account is suspended (plan §8.2)' }),
    tripCount: z.number().int(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminVehicleRow' });

export const adminVehiclesResponseSchema = z
  .object({
    vehicles: z.array(adminVehicleRowSchema),
    total: z.number().int(),
    page: z.number().int(),
    host: z
      .object({ id: z.string(), name: z.string() })
      .optional()
      .meta({ description: 'The Host named by hostId, to label the filter' }),
  })
  .meta({ id: 'AdminVehicles' });

export const keyChangeSchema = z
  .object({
    field: z.enum(KEY_DETAILS),
    before: z
      .string()
      .optional()
      .meta({ description: 'While the listing was live; left out when it had none' }),
    after: z.string().optional().meta({ description: 'Now; left out when the Host removed it' }),
    changedAt: z.iso.datetime(),
  })
  .meta({ id: 'KeyChange' });

export const adminVehicleSchema = z
  .object({
    vehicle: hostVehicleSchema,
    keyChanges: z.array(keyChangeSchema).meta({
      description:
        'What the Host changed among the plate, VIN, chassis number, make, model and year since the listing was live (plan §3). Empty until they change one; cleared when staff approve or reject the listing.',
    }),
    upcomingBookings: z.array(bookingRowSchema).optional().meta({
      description:
        'While the car is suspended: its pending, confirmed and current bookings, for staff to keep or cancel (plan §8.2)',
    }),
    host: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      phone: z
        .string()
        .optional()
        .meta({ description: 'The verified mobile, to reach the Host about the listing' }),
      status: z.enum(HOST_STATUSES).nullable(),
      payoutsEnabled: z
        .boolean()
        .meta({ description: 'Payout setup is done, so an approved listing goes live at once (plan §8.2)' }),
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
