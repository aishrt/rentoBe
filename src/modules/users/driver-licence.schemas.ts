import { z } from 'zod';
import { ENGLISH_PROOFS, LICENCE_CLASSES, VERIFICATION_STATUSES } from './user.model.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use a date like 1990-04-21' });

/**
 * Licence details at checkout (plan §9, Days 11–13: "mobile SMS code and licence details now; the
 * identity check is connected on Days 19–20"). NZ licences have 2 letters and 6 digits, and a
 * 3-digit version number (plan §3, Validation rules).
 */
export const driverLicenceInputSchema = z
  .object({
    number: z.string().trim().toUpperCase().min(4).max(20),
    version: z
      .string()
      .trim()
      .regex(/^\d{3}$/, { error: 'The version number has 3 digits' })
      .optional(),
    country: z.string().trim().min(2).max(60).default('New Zealand'),
    class: z.enum(LICENCE_CLASSES),
    englishProof: z.enum(ENGLISH_PROOFS).optional().meta({
      description: 'For an overseas licence that isn’t in English: an IDP or an approved translation',
    }),
    notInEnglish: z.boolean().default(false),
    issuedAt: date.meta({ description: 'When the licence was first issued' }),
    expiry: date,
    dob: date.meta({ description: 'Date of birth, for the minimum age' }),
  })
  .superRefine((value, ctx) => {
    if (value.class !== 'OVERSEAS') {
      if (!/^[A-Z]{2}\d{6}$/.test(value.number)) {
        ctx.addIssue({
          code: 'custom',
          path: ['number'],
          message: 'NZ licence numbers have 2 letters and 6 digits',
        });
      }
      if (!value.version) {
        ctx.addIssue({ code: 'custom', path: ['version'], message: 'Enter the 3-digit version number' });
      }
    } else if (!/^[A-Z0-9-]{4,20}$/.test(value.number)) {
      ctx.addIssue({
        code: 'custom',
        path: ['number'],
        message: 'Enter the licence number as it appears on the card',
      });
    }
    if (value.class === 'OVERSEAS' && value.notInEnglish && !value.englishProof) {
      ctx.addIssue({
        code: 'custom',
        path: ['englishProof'],
        message: 'Bring an International Driving Permit or an approved translation',
      });
    }
  })
  .meta({ id: 'DriverLicenceInput' });
export type DriverLicenceInput = z.infer<typeof driverLicenceInputSchema>;

export const ELIGIBILITY_CODES = [
  'PHONE_REQUIRED',
  'LICENCE_REQUIRED',
  'TOO_YOUNG',
  'CLASS_NOT_ACCEPTED',
  'NOT_LICENSED_LONG_ENOUGH',
  'LICENCE_EXPIRES',
  'ENGLISH_PROOF_REQUIRED',
  'LICENCE_REJECTED',
  'IDENTITY_REJECTED',
] as const;

export const checkoutReadinessSchema = z
  .object({
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    phone: z.string().optional(),
    licence: z
      .object({
        class: z.enum(LICENCE_CLASSES),
        country: z.string(),
        numberEnding: z.string().meta({ description: 'The last 3 characters, to recognise it' }),
        expiry: date,
        status: z.enum(VERIFICATION_STATUSES),
        englishProof: z.enum(ENGLISH_PROOFS).optional(),
      })
      .nullable(),
    hasDateOfBirth: z.boolean(),
    identityStatus: z.enum(VERIFICATION_STATUSES),
    problems: z.array(z.object({ code: z.enum(ELIGIBILITY_CODES), message: z.string() })).meta({
      description: 'Anything that stops this person booking; with `end`, checked against that trip end',
    }),
  })
  .meta({ id: 'CheckoutReadiness' });
export type CheckoutReadiness = z.infer<typeof checkoutReadinessSchema>;
