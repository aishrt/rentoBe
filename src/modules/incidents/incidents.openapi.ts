import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { INCIDENT_STATUSES } from './incident.model.js';
import {
  incidentAssigneeSchema,
  incidentAssigneesResponseSchema,
  incidentChargeSchema,
  incidentReplySchema,
  incidentResponseSchema,
  incidentsResponseSchema,
  newIncidentSchema,
  staffIncidentUpdateSchema,
  staffNewIncidentSchema,
} from './incidents.schemas.js';

const refParams = z.object({ ref: z.string().meta({ description: 'The case number, e.g. IN-4F7K2Q' }) });

/** The contract for incidents.routes.ts and the staff portal's incident routes (plan §2.3). */
export function registerIncidentPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'post',
    path: '/incidents',
    tags: ['Incidents'],
    summary: 'Report damage or an incident on a booking',
    description:
      'By the booking’s Guest or Host, with photos and documents uploaded first (purpose INCIDENT_FILE). Damage must be reported within the damage-report window after check-out. With fromCheckOutDamage, a damage report opens with the new damage flagged on the check-out record that no other case has yet: its photos as evidence and its notes in the description (409 NO_NEW_DAMAGE when there is none). Holds the booking’s payouts until the case is settled.',
    security: signedIn,
    request: { body: jsonBody(newIncidentSchema) },
    responses: { 201: jsonResponse('Opened', incidentResponseSchema), ...errorResponses(400, 401, 404, 409) },
  });

  registry.registerPath({
    method: 'get',
    path: '/incidents',
    tags: ['Incidents'],
    summary: 'Cases on your bookings',
    security: signedIn,
    responses: { 200: jsonResponse('Cases', incidentsResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'get',
    path: '/incidents/{ref}',
    tags: ['Incidents'],
    summary: 'A case and its history',
    description: 'Each party sees the events for both parties and their own; internal notes are for staff.',
    security: signedIn,
    request: { params: refParams },
    responses: { 200: jsonResponse('The case', incidentResponseSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/incidents/{ref}/events',
    tags: ['Incidents'],
    summary: 'Add an update or evidence to an open case',
    security: signedIn,
    request: { params: refParams, body: jsonBody(incidentReplySchema) },
    responses: {
      201: jsonResponse('Added', incidentResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/incidents',
    tags: ['Admin'],
    summary: 'Staff: cases, open ones by default',
    security: signedIn,
    request: { query: z.object({ status: z.enum(INCIDENT_STATUSES).optional() }) },
    responses: { 200: jsonResponse('Cases', incidentsResponseSchema), ...errorResponses(401, 403) },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/incidents',
    tags: ['Admin'],
    summary: 'Staff: open a case on a booking',
    description:
      'Outside the damage-report window, on any booking past checkout (404 otherwise). For both parties, only the Guest or the Host it’s about, or the team only (INTERNAL) until an update is shared; a party never sees a case with nothing for them. The staff member who opens it has it. Holds the booking’s payouts until the case is settled, tells the parties who can see it, and is written to the audit log.',
    security: signedIn,
    request: { body: jsonBody(staffNewIncidentSchema) },
    responses: {
      201: jsonResponse('Opened', incidentResponseSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/incidents/assignees',
    tags: ['Admin'],
    summary: 'Staff: who a case can be assigned to',
    description: 'The admin first, then the active support team by name.',
    security: signedIn,
    responses: {
      200: jsonResponse('Assignees', incidentAssigneesResponseSchema),
      ...errorResponses(401, 403),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/incidents/{ref}',
    tags: ['Admin'],
    summary: 'Staff: a case with every event',
    security: signedIn,
    request: { params: refParams },
    responses: { 200: jsonResponse('The case', incidentResponseSchema), ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/incidents/{ref}/events',
    tags: ['Admin'],
    summary: 'Staff: post an update, change the status or take the case',
    description:
      'Updates go to both parties, one of them, or the team only (INTERNAL). The status moves only to one of the case’s `nextStatuses`: nothing goes back to OPEN, a resolved case can be reopened (INVESTIGATING or AWAITING_RESPONSE), and a closed one is final (409 INVALID_STATUS_CHANGE; 409 CASE_CHANGED when someone else changed the status meanwhile). Resolving or closing the last open case on a booking releases its payouts; reopening a case holds the unpaid ones again.',
    security: signedIn,
    request: { params: refParams, body: jsonBody(staffIncidentUpdateSchema) },
    responses: {
      200: jsonResponse('Updated', incidentResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/incidents/{ref}/assignee',
    tags: ['Admin'],
    summary: 'Staff: assign the case to a staff member, or to nobody',
    description:
      'Any support member or the admin can hand a case to any of them (409 NOT_STAFF for anyone else). Recorded as an internal ASSIGNED or UNASSIGNED event and in the audit log; the new assignee is notified. Choosing whoever has it already changes nothing.',
    security: signedIn,
    request: { params: refParams, body: jsonBody(incidentAssigneeSchema) },
    responses: {
      200: jsonResponse('Assigned', incidentResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/incidents/{ref}/charges',
    tags: ['Admin'],
    summary: 'Staff: charge the guest from a resolved case',
    description: 'Charged to the Guest’s saved card; the Host’s share is paid out as its own payout.',
    security: signedIn,
    request: { params: refParams, body: jsonBody(incidentChargeSchema) },
    responses: {
      200: jsonResponse('Charged', incidentResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
