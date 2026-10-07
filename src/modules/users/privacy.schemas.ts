import { z } from 'zod';

/** What a user can ask about their personal information (NZ Privacy Act 2020, plan §8.2 and §14). */
export const PRIVACY_REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'CLOSE_ACCOUNT'] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const privacyRequestSchema = z
  .object({
    type: z.enum(PRIVACY_REQUEST_TYPES).meta({
      description:
        'ACCESS: a copy of their information. CORRECTION: something to fix (say what). CLOSE_ACCOUNT: close and anonymise the account',
    }),
    message: z.string().trim().max(2000, { error: 'Keep it under 2,000 characters' }).optional(),
  })
  .superRefine((input, context) => {
    if (input.type === 'CORRECTION' && (input.message?.length ?? 0) < 10) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'Tell us what needs correcting (at least 10 characters)',
      });
    }
  })
  .meta({ id: 'PrivacyRequest' });
export type PrivacyRequestInput = z.infer<typeof privacyRequestSchema>;

export const privacyRequestResponseSchema = z
  .object({
    ref: z.string().meta({ description: 'The support ticket reference, e.g. ST-4HX8PA' }),
    alreadyOpen: z
      .boolean()
      .meta({ description: 'The same request was already open, so no new one was made' }),
  })
  .meta({ id: 'PrivacyRequestResponse' });

export const CLOSURE_BLOCKERS = [
  'UPCOMING_TRIP',
  'HOSTED_BOOKING',
  'OPEN_INCIDENT',
  'UNPAID_CHARGE',
  'PAYOUT_DUE',
] as const;

export const accountClosureSchema = z
  .object({
    allowed: z.boolean(),
    blockers: z.array(z.object({ code: z.enum(CLOSURE_BLOCKERS), message: z.string() })).meta({
      description:
        'Why the account can’t be closed yet (plan §8.2): a trip or booking still to come or under way, an open incident, an unpaid charge or a payout still due',
    }),
  })
  .meta({ id: 'AccountClosure' });
export type AccountClosure = z.infer<typeof accountClosureSchema>;
