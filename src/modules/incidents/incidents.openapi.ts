import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { INCIDENT_STATUSES } from './incident.model.js';
import {
  incidentChargeSchema,
  incidentReplySchema,
  incidentResponseSchema,
  incidentsResponseSchema,
  newIncidentSchema,
  staffIncidentUpdateSchema,
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
      'By the booking’s Guest or Host, with photos and documents uploaded first (purpose INCIDENT_FILE). Damage must be reported within the damage-report window after check-out. Holds the booking’s payouts until the case is settled.',
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
      'Updates go to both parties, one of them, or the team only (INTERNAL). Resolving or closing the last open case on a booking releases its payouts.',
    security: signedIn,
    request: { params: refParams, body: jsonBody(staffIncidentUpdateSchema) },
    responses: {
      200: jsonResponse('Updated', incidentResponseSchema),
      ...errorResponses(400, 401, 403, 404),
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
