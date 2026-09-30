import { z } from 'zod';
import { HOST_STATUSES } from '../users/user.model.js';

/** An NZ GST number: 8 or 9 digits, written 123-456-789. */
const gstNumber = z
  .string()
  .trim()
  .regex(/^\d{2,3}-?\d{3}-?\d{3}$/, { error: 'GST numbers look like 123-456-789' })
  .transform((value) => {
    const digits = value.replace(/-/g, '');
    return `${digits.slice(0, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
  });

/** The Host application (plan §9, Days 8–11): a short profile, GST status and the Host Agreement. */
export const hostApplicationSchema = z
  .object({
    bio: z.string().trim().max(1000, { error: 'Keep it under 1,000 characters' }).optional(),
    gstRegistered: z.boolean().default(false),
    gstNumber: gstNumber.optional(),
    acceptHostAgreement: z.literal(true, { error: 'Please accept the Host Agreement' }),
  })
  .refine((value) => !value.gstRegistered || value.gstNumber, {
    error: 'Enter your GST number',
    path: ['gstNumber'],
  })
  .meta({ id: 'HostApplicationRequest' });
export type HostApplicationInput = z.infer<typeof hostApplicationSchema>;

export const hostProfilePatchSchema = z
  .object({
    bio: z.string().trim().max(1000).optional(),
    gstRegistered: z.boolean().optional(),
    gstNumber: gstNumber.optional().or(z.literal('').transform(() => undefined)),
  })
  .meta({ id: 'HostProfilePatch' });
export type HostProfilePatch = z.infer<typeof hostProfilePatchSchema>;

export const hostProfileSchema = z
  .object({
    status: z.enum(HOST_STATUSES),
    appliedAt: z.iso.datetime(),
    reviewNotes: z.string().optional().meta({ description: 'Why an application was rejected, if it was' }),
    bio: z.string().optional(),
    gstRegistered: z.boolean(),
    gstNumber: z.string().optional(),
    payoutsEnabled: z.boolean().meta({ description: 'Payout setup (Stripe Connect) arrives in Phase 3' }),
    rating: z.object({ avg: z.number(), count: z.number().int() }),
    tripCount: z.number().int(),
    responseRate: z.number().optional(),
  })
  .meta({ id: 'HostProfile' });
export type HostProfileView = z.infer<typeof hostProfileSchema>;

export const hostProfileResponseSchema = z
  .object({ host: hostProfileSchema })
  .meta({ id: 'HostProfileResponse' });
