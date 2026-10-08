import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { INSPECTION_STAGES } from './condition-report.model.js';
import { flagDamageSchema, handoverResponseSchema, inspectionInputSchema } from './inspections.schemas.js';

const bookingParams = z.object({ id: z.string().meta({ description: 'The booking id or reference' }) });

/** The contract for the handover routes in bookings.routes.ts and admin.routes.ts (plan §2.3). */
export function registerInspectionPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/bookings/{id}/inspections',
    tags: ['Handover'],
    summary: 'The check-in and check-out reports, and what you can do next',
    security: signedIn,
    request: { params: bookingParams },
    responses: { 200: jsonResponse('The handover', handoverResponseSchema), ...errorResponses(401, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/inspections',
    tags: ['Handover'],
    summary: 'Record the check-in or check-out',
    description:
      'Photos of every required angle (uploaded first with POST /uploads/signature, purpose INSPECTION_PHOTO), the odometer, the fuel or battery level and damage pins. Check-in opens 2 hours before the start and starts the trip; check-out completes it. The Guest must have confirmed their email before check-in. The other party is asked to confirm.',
    security: signedIn,
    request: { params: bookingParams, body: jsonBody(inspectionInputSchema) },
    responses: {
      201: jsonResponse('Recorded', handoverResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/inspections/{stage}/confirm',
    tags: ['Handover'],
    summary: 'Confirm the other party’s report',
    security: signedIn,
    request: { params: bookingParams.extend({ stage: z.enum(INSPECTION_STAGES) }) },
    responses: { 200: jsonResponse('Confirmed', handoverResponseSchema), ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/bookings/{id}/inspections/CHECK_OUT/damage',
    tags: ['Handover'],
    summary: 'Flag new damage after the trip',
    description:
      'The Guest until they confirm the check-out; the Host until the damage-report window in settings closes. Open an incident to claim for it.',
    security: signedIn,
    request: { params: bookingParams, body: jsonBody(flagDamageSchema) },
    responses: {
      200: jsonResponse('Flagged', handoverResponseSchema),
      ...errorResponses(400, 401, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/bookings/{id}/complete',
    tags: ['Admin'],
    summary: 'Staff: complete a trip whose check-out is missing',
    description:
      'With the Host’s odometer and fuel reading and photos (plan §8.2). The booking becomes COMPLETED, and extra kilometres, reviews and the payout follow as normal.',
    security: signedIn,
    request: { params: bookingParams, body: jsonBody(inspectionInputSchema.omit({ stage: true })) },
    responses: {
      200: jsonResponse('Completed', handoverResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
