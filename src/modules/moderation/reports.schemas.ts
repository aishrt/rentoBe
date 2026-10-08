import { z } from 'zod';
import { REPORT_REASONS, REPORT_TARGET_TYPES } from './report.model.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/, { error: 'Unknown item' });

/** POST /reports: report a user, a message, a review or a listing to support (spec §13, §16). */
export const reportInputSchema = z
  .object({
    targetType: z.enum(REPORT_TARGET_TYPES),
    targetId: objectId,
    reason: z.enum(REPORT_REASONS, { error: 'Choose a reason' }),
    note: z.string().trim().max(2000, { error: 'Keep it under 2,000 characters' }).optional(),
  })
  .meta({ id: 'ReportRequest' });
export type ReportInput = z.infer<typeof reportInputSchema>;

export const reportResponseSchema = z
  .object({ id: z.string(), status: z.literal('OPEN') })
  .meta({ id: 'ReportResponse' });

export const blockedUsersResponseSchema = z
  .object({
    users: z.array(z.object({ id: z.string(), firstName: z.string(), avatarUrl: z.string().optional() })),
  })
  .meta({ id: 'BlockedUsers' });
