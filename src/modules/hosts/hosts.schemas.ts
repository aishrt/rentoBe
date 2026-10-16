import { z } from 'zod';
import { isValidGstNumber } from '../../lib/gst-number.js';
import { HOST_STATUSES } from '../users/user.model.js';

/** What a GST number that fails Inland Revenue's check digit is told. */
export const GST_CHECK_DIGIT_ERROR = 'That isn’t a valid GST number. Check it on your IRD registration.';

const GST_FORMAT = /^\d{2,3}-?\d{3}-?\d{3}$/;
const GST_FORMAT_ERROR = 'GST numbers look like 123-456-789';
const writtenAsGst = (value: string) => {
  const digits = value.replace(/-/g, '');
  return `${digits.slice(0, -6)}-${digits.slice(-6, -3)}-${digits.slice(-3)}`;
};

/** An NZ GST number: 8 or 9 digits, written 123-456-789, with Inland Revenue's check digit. */
const gstNumber = z
  .string()
  .trim()
  .regex(GST_FORMAT, { error: GST_FORMAT_ERROR })
  .refine(isValidGstNumber, { error: GST_CHECK_DIGIT_ERROR })
  .transform(writtenAsGst);

/**
 * The same, without the check digit: the Host profile checks that only for a number that's changed
 * (updateHostProfile), as its form sends the number with every save and one saved before the check came in
 * stands until the Host changes it.
 */
const profileGstNumber = z
  .string()
  .trim()
  .regex(GST_FORMAT, { error: GST_FORMAT_ERROR })
  .transform(writtenAsGst);

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
    gstNumber: profileGstNumber.optional().or(z.literal('').transform(() => undefined)),
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
    payoutsEnabled: z.boolean().meta({ description: 'Whether payout setup (Stripe Connect) is finished' }),
    identityRequired: z.boolean().meta({
      description:
        'Whether approval waits for a passed identity check (the identityForHosts platform setting)',
    }),
    rating: z.object({ avg: z.number(), count: z.number().int() }),
    tripCount: z.number().int(),
    responseRate: z.number().optional(),
  })
  .meta({ id: 'HostProfile' });
export type HostProfileView = z.infer<typeof hostProfileSchema>;

export const hostProfileResponseSchema = z
  .object({ host: hostProfileSchema })
  .meta({ id: 'HostProfileResponse' });
