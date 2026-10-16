import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { INSPECTION_STAGES } from './condition-report.model.js';
import {
  flagDamageSchema,
  handoverResponseSchema,
  inspectionInputSchema,
  readingCorrectionSchema,
  staffCompletionSchema,
  staffHandoverResponseSchema,
} from './inspections.schemas.js';

const bookingParams = z.object({ id: z.string().meta({ description: 'The booking id or reference' }) });

/** The contract for the handover routes in bookings.routes.ts and admin.routes.ts (plan §2.3). */
export function registerInspectionPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/bookings/{id}/inspections',
    tags: ['Handover'],
    summary: 'The check-in and check-out reports, and what you can do next',
    description:
      'For the Guest, the Host and staff (role STAFF, with no actions: staff complete a trip with POST /admin/bookings/{id}/complete).',
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
      'Photos of every required angle (uploaded first with POST /uploads/signature, purpose INSPECTION_PHOTO), the odometer, the fuel or battery level and damage pins. Each upload is attached once: a key sent twice, or already on a report, is refused (400). A party’s photos can’t be taken before check-in opened, or, for check-out, before the check-in (400 PHOTOS_TOO_EARLY). Check-in opens 2 hours before the start and starts the trip, and closes at the end time (409 CHECK_IN_CLOSED: support sorts out the booking); check-out completes it, also on a trip support marked as started without a check-in (no extra kilometres are then worked out). The Guest must have confirmed their email before check-in. 409 NOT_CHECK_IN or NOT_CHECK_OUT when it’s already done, also by the other party at the same moment. The other party is asked to confirm.',
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
    description:
      'Once both parties have confirmed the check-out (or the Guest has, when support completed the trip), any extra kilometres are charged without waiting for the damage-report window to close.',
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
      'Either party, once the check-out is recorded, until the damage-report window in settings closes (409 DAMAGE_WINDOW_CLOSED after it). Open an incident to claim for it.',
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
      'With the Host’s odometer and fuel or battery reading, and any photos they sent (plan §8.2), which become the check-out record. The booking becomes COMPLETED, and extra kilometres (worked out against the check-in reading, when there is one), reviews and the payout follow as normal: the extra kilometres wait like any check-out’s, charged once the Guest confirms the readings or when the damage-report window closes (`handover.extraKmStatus` says where they stand). Charging them sooner is POST /admin/bookings/{id}/extra-km, with the refunds permission. 409 NOT_CHECK_OUT unless the trip is under way without a check-out; 400 when the odometer is below the check-in reading.',
    security: signedIn,
    request: { params: bookingParams, body: jsonBody(staffCompletionSchema) },
    responses: {
      200: jsonResponse('Completed', handoverResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/bookings/{id}/readings',
    tags: ['Admin'],
    summary: 'Staff with the refunds permission: correct a reading on a condition report',
    description:
      'The odometer and/or fuel or battery level of the CHECK_IN or CHECK_OUT report, with a note for the audit log (before and after are logged). The check-out odometer can’t be below the check-in one (400). Both parties see the correction in the booking’s messages. On a completed trip a changed odometer works the extra kilometres out again at once (`extraKm`): a charge not yet paid is cancelled and replaced; one paid already stays, with any more due charged on top, or what was paid over to refund with the refund tools. 404 when that report isn’t done yet.',
    security: signedIn,
    request: { params: bookingParams, body: jsonBody(readingCorrectionSchema) },
    responses: {
      200: jsonResponse('Corrected', staffHandoverResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/bookings/{id}/extra-km',
    tags: ['Admin'],
    summary: 'Staff with the refunds permission: charge the extra kilometres now',
    description:
      'From the readings as they stand, without the daily review limit (`trips.extraKmReviewAboveKmPerDay`) and without waiting for the other party to confirm the check-out: for a charge held for review once staff have checked the readings. A charge not yet paid is replaced if the amount differs. 409 NOT_COMPLETED or NO_READINGS when there’s nothing to work it out from.',
    security: signedIn,
    request: { params: bookingParams },
    responses: {
      200: jsonResponse('Charged', staffHandoverResponseSchema),
      ...errorResponses(401, 403, 404, 409),
    },
  });
}
