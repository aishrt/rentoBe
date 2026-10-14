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
      .max(5000, { error: 'Keep it under 5,000 characters' })
      .optional()
      .meta({ description: 'Needed unless fromCheckOutDamage is set, when the flagged damage describes it' }),
    attachments: z
      .array(attachmentInputSchema)
      .max(10, { error: 'Up to 10 files' })
      .default([])
      .meta({ description: 'Photos and documents, uploaded first with purpose INCIDENT_FILE' }),
    fromCheckOutDamage: z.boolean().optional().meta({
      description:
        'DAMAGE only: opens the case with the new damage flagged on the check-out record that no other case has yet. Its notes go into the description and its photos into the evidence. 409 NO_NEW_DAMAGE when there is none.',
    }),
  })
  .refine((input) => input.description !== undefined || input.fromCheckOutDamage, {
    error: 'Tell us what happened (at least 10 characters)',
    path: ['description'],
  })
  .refine((input) => !input.fromCheckOutDamage || input.type === 'DAMAGE', {
    error: 'Only a damage report can include the damage flagged at check-out',
    path: ['fromCheckOutDamage'],
  })
  // A toll or an infringement notice is reported with the notice itself (plan §8.2, tolls and fines).
  .refine((input) => !['TOLL', 'FINE'].includes(input.type) || input.attachments.length > 0, {
    error: 'Attach a photo or PDF of the notice',
    path: ['attachments'],
  })
  .meta({ id: 'NewIncidentRequest' });
export type NewIncidentInput = z.infer<typeof newIncidentSchema>;

/** Support opens a case themselves (plan §3: staff can, outside the damage-report window). */
export const staffNewIncidentSchema = z
  .object({
    bookingRef: z
      .string()
      .regex(/^RV-[A-Za-z0-9]{6}$/, { error: 'Enter a booking reference like RV-7K2Q9M' }),
    type: z.enum(INCIDENT_TYPES, { error: 'Choose what happened' }),
    description: z
      .string()
      .trim()
      .min(10, { error: 'Say what happened (at least 10 characters)' })
      .max(5000, { error: 'Keep it under 5,000 characters' }),
    attachments: z
      .array(attachmentInputSchema)
      .max(10, { error: 'Up to 10 files' })
      .default([])
      .meta({ description: 'Photos and documents, uploaded first with purpose INCIDENT_FILE' }),
    visibility: z.enum(EVENT_VISIBILITIES).default('BOTH').meta({
      description:
        'Who sees the case: BOTH parties, only the GUEST or the HOST it’s about, or INTERNAL to support staff until an update is shared with a party',
    }),
  })
  .meta({ id: 'StaffNewIncidentRequest' });
export type StaffNewIncidentInput = z.infer<typeof staffNewIncidentSchema>;

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
    visibility: z.enum(EVENT_VISIBILITIES).optional().meta({
      description:
        'BOTH parties, only the GUEST or HOST, or INTERNAL to support staff. Without it, whoever already sees the case (the case’s `audience`). Taking the case with nothing else (assignToMe alone) is always INTERNAL, and nobody is told',
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

/** Support hands a case to a staff member, or leaves it with nobody. */
export const incidentAssigneeSchema = z
  .object({
    userId: z
      .string()
      .regex(/^[0-9a-f]{24}$/, { error: 'Choose who handles it' })
      .nullable()
      .meta({
        description:
          'An active support member or the admin (from GET /admin/incidents/assignees); null for nobody',
      }),
  })
  .meta({ id: 'IncidentAssigneeRequest' });
export type IncidentAssigneeInput = z.infer<typeof incidentAssigneeSchema>;

export const incidentChargeSchema = z
  .object({
    type: z.enum(EXTRA_CHARGE_TYPES.filter((type) => type !== 'EXTRA_KM') as [string, ...string[]]),
    description: z.string().trim().min(3).max(200),
    amountCents: z.number().int().min(1, { error: 'Enter an amount' }).max(1_000_000).meta({
      description:
        'On a damage, accident or theft case under a protection plan, the case’s charges together stay within the plan’s excess (`chargeLimitCents`; 409 OVER_EXCESS above it); on any other case, its DAMAGE charges do',
    }),
    idempotencyKey: z.string().trim().min(8).max(100).optional().meta({
      description:
        'A new value (such as a UUID) for each charge the form submits: the same one sent again adds no second charge',
    }),
  })
  .meta({ id: 'IncidentChargeRequest' });
export type IncidentChargeInput = z.infer<typeof incidentChargeSchema>;

export const incidentEventViewSchema = z
  .object({
    id: z.string(),
    action: z.string().meta({
      description:
        'OPENED, COMMENT, STATUS, ASSIGNED, UNASSIGNED, CHARGE_ADDED, CHARGE_CANCELLED, CHARGE_REFUNDED',
    }),
    by: z.enum(['YOU', 'GUEST', 'HOST', 'SUPPORT']),
    byName: z.string(),
    note: z.string().optional(),
    attachments: z.array(attachmentViewSchema),
    visibility: z.enum(EVENT_VISIBILITIES),
    status: z.enum(INCIDENT_STATUSES).optional(),
    assignedTo: z
      .string()
      .optional()
      .meta({ description: 'Staff only, on an ASSIGNED event that handed the case to someone else: who' }),
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
    awaitingYou: z.boolean().optional().meta({
      description:
        'Guest and Host only: support is waiting for the viewer’s answer (the case awaits a response, and support asked them, not only the other party)',
    }),
    assignedTo: z.string().optional().meta({ description: 'Staff only: the support member handling it' }),
    assignedToId: z.string().optional().meta({ description: 'Staff only: their user id' }),
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
    sharedWithOtherParty: z.boolean().optional().meta({
      description:
        'Guest and Host only: whether the viewer’s next update is shared with the other party. It is when the other party sees the case, unless support’s latest update to the viewer was for them alone (such as a question asked only them): the answer stays between the viewer and support',
    }),
    audience: z.enum(EVENT_VISIBILITIES).optional().meta({
      description:
        'Staff only: who sees the case now: BOTH parties, only the GUEST or the HOST, or INTERNAL to the team. An update goes to them unless staff choose otherwise',
    }),
    nextStatuses: z.array(z.enum(INCIDENT_STATUSES)).optional().meta({
      description:
        'Staff only: the statuses the case can move to now. A resolved case can be reopened; a closed one is final',
    }),
    protectionPlan: z
      .object({ name: z.string(), excessCents: z.number().int() })
      .optional()
      .meta({ description: 'Staff only: the protection plan the Guest booked, when they took one' }),
    chargeLimitCents: z.number().int().optional().meta({
      description:
        'Staff only, on a damage, accident or theft case under a protection plan: how much more the case can charge the Guest, so its charges stay within the plan’s excess (plan §3)',
    }),
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

/** The staff list: open cases by default, or one status, a page at a time. */
export const STAFF_INCIDENTS_PAGE_SIZE = 50;
export const staffIncidentListQuerySchema = z.object({
  status: z.enum(INCIDENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export const staffIncidentsResponseSchema = incidentsResponseSchema
  .extend({ total: z.number().int(), page: z.number().int() })
  .meta({ id: 'StaffIncidents' });

/** Who a case can be handed to: the admin and the active support team. */
export const incidentAssigneesResponseSchema = z
  .object({
    assignees: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        you: z.boolean().meta({ description: 'The signed-in staff member' }),
      }),
    ),
  })
  .meta({ id: 'IncidentAssignees' });
export type IncidentAssignees = z.infer<typeof incidentAssigneesResponseSchema>;
