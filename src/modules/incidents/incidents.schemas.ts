import { z } from 'zod';
import { EXTRA_CHARGE_TYPES } from '../bookings/booking.model.js';
import { attachmentInputSchema, attachmentViewSchema } from '../uploads/uploads.schemas.js';
import { EVENT_VISIBILITIES, INCIDENT_STATUSES, INCIDENT_TYPES } from './incident.model.js';

/* Damage and incident reporting (spec §15; plan §9 Days 20–21). */

export const newIncidentSchema = z
  .object({
    bookingRef: z.string().regex(/^RV-[A-Za-z0-9]{6}$/, { error: 'Choose the booking' }),
    type: z.enum(INCIDENT_TYPES, { error: 'Choose what happened' }),
    description: z
      .string()
      .trim()
      .min(10, { error: 'Tell us what happened (at least 10 characters)' })
      .max(5000, { error: 'Keep it under 5,000 characters' }),
    attachments: z
      .array(attachmentInputSchema)
      .max(10, { error: 'Up to 10 files' })
      .default([])
      .meta({ description: 'Photos and documents, uploaded first with purpose INCIDENT_FILE' }),
  })
  .meta({ id: 'NewIncidentRequest' });
export type NewIncidentInput = z.infer<typeof newIncidentSchema>;

export const incidentReplySchema = z
  .object({
    note: z.string().trim().max(5000).default(''),
    attachments: z.array(attachmentInputSchema).max(10).default([]),
  })
  .refine((input) => input.note.length > 0 || input.attachments.length > 0, {
    error: 'Write an update or add a file',
    path: ['note'],
  })
  .meta({ id: 'IncidentReplyRequest' });
export type IncidentReplyInput = z.infer<typeof incidentReplySchema>;

export const staffIncidentUpdateSchema = z
  .object({
    note: z.string().trim().max(5000).default(''),
    attachments: z.array(attachmentInputSchema).max(10).default([]),
    visibility: z.enum(EVENT_VISIBILITIES).default('BOTH').meta({
      description: 'BOTH parties, only the GUEST or HOST, or INTERNAL to support staff',
    }),
    status: z.enum(INCIDENT_STATUSES).optional(),
    assignToMe: z.boolean().optional(),
  })
  .refine(
    (input) => input.note.length > 0 || input.attachments.length > 0 || input.status || input.assignToMe,
    {
      error: 'Write an update, change the status or take the case',
      path: ['note'],
    },
  )
  .meta({ id: 'StaffIncidentUpdateRequest' });
export type StaffIncidentUpdateInput = z.infer<typeof staffIncidentUpdateSchema>;

export const incidentChargeSchema = z
  .object({
    type: z.enum(EXTRA_CHARGE_TYPES.filter((type) => type !== 'EXTRA_KM') as [string, ...string[]]),
    description: z.string().trim().min(3).max(200),
    amountCents: z.number().int().min(1, { error: 'Enter an amount' }).max(1_000_000),
  })
  .meta({ id: 'IncidentChargeRequest' });
export type IncidentChargeInput = z.infer<typeof incidentChargeSchema>;

export const incidentEventViewSchema = z
  .object({
    id: z.string(),
    action: z.string().meta({ description: 'OPENED, COMMENT, STATUS, ASSIGNED, CHARGE_ADDED' }),
    by: z.enum(['YOU', 'GUEST', 'HOST', 'SUPPORT']),
    byName: z.string(),
    note: z.string().optional(),
    attachments: z.array(attachmentViewSchema),
    visibility: z.enum(EVENT_VISIBILITIES),
    status: z.enum(INCIDENT_STATUSES).optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'IncidentEvent' });

export const incidentSummarySchema = z
  .object({
    caseRef: z.string(),
    bookingRef: z.string(),
    vehicleTitle: z.string(),
    type: z.enum(INCIDENT_TYPES),
    status: z.enum(INCIDENT_STATUSES),
    reportedBy: z.enum(['GUEST', 'HOST', 'SUPPORT']),
    role: z.enum(['GUEST', 'HOST', 'STAFF']).meta({ description: 'How the viewer sees the case' }),
    assignedTo: z.string().optional().meta({ description: 'Staff only: the support member handling it' }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'IncidentSummary' });

export const incidentViewSchema = incidentSummarySchema
  .extend({
    description: z.string(),
    events: z
      .array(incidentEventViewSchema)
      .meta({ description: 'Oldest first; only those the viewer may see' }),
    canReply: z.boolean(),
    extraCharges: z
      .array(
        z.object({
          type: z.enum(EXTRA_CHARGE_TYPES),
          description: z.string(),
          amountCents: z.number().int(),
          status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
        }),
      )
      .meta({ description: 'Charges added to the booking from this case' }),
  })
  .meta({ id: 'Incident' });
export type IncidentView = z.infer<typeof incidentViewSchema>;

export const incidentResponseSchema = z
  .object({ incident: incidentViewSchema })
  .meta({ id: 'IncidentResponse' });
export const incidentsResponseSchema = z
  .object({ incidents: z.array(incidentSummarySchema) })
  .meta({ id: 'Incidents' });
