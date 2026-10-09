import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  blockInputSchema,
  calendarBlockSchema,
  calendarResponseSchema,
  hostVehicleResponseSchema,
} from '../vehicles/host-vehicles.schemas.js';
import {
  adminVehicleSchema,
  adminVehiclesResponseSchema,
  documentDecisionSchema,
  hostApplicationsResponseSchema,
  photoDecisionSchema,
  requiredNotesSchema,
  reviewNotesSchema,
  reviewQueueResponseSchema,
  vehicleListQuerySchema,
} from './admin-listings.schemas.js';

const userParam = z.object({ userId: z.string() });
const idParam = z.object({ id: z.string().meta({ description: 'The car’s id' }) });

/** The staff portal's approval queues and calendar override (plan §9, Days 8–11). Admin and Support. */
export function registerAdminListingPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/admin/host-applications',
    tags: ['Admin'],
    summary: 'Host applications',
    description: 'Oldest first. `status` is APPLIED by default.',
    security: signedIn,
    request: {
      query: z.object({ status: z.enum(['APPLIED', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional() }),
    },
    responses: {
      200: jsonResponse('Applications', hostApplicationsResponseSchema),
      ...errorResponses(401, 403),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/host-applications/{userId}/approve',
    tags: ['Admin'],
    summary: 'Approve a Host application',
    description:
      '409 EMAIL_NOT_VERIFIED until the applicant has confirmed their email, and 409 IDENTITY_NOT_VERIFIED until their identity check has passed (while the identityForHosts setting is on). Emails the Host.',
    security: signedIn,
    request: { params: userParam, body: jsonBody(reviewNotesSchema) },
    responses: {
      200: jsonResponse('The new status', z.object({ status: z.string() }).meta({ id: 'HostDecision' })),
      ...errorResponses(401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/host-applications/{userId}/reject',
    tags: ['Admin'],
    summary: 'Reject a Host application',
    security: signedIn,
    request: { params: userParam, body: jsonBody(requiredNotesSchema) },
    responses: {
      200: jsonResponse('The new status', z.object({ status: z.string() })),
      ...errorResponses(400, 401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/vehicles',
    tags: ['Admin'],
    summary: 'The listing review queue',
    description: 'Listings under review, and live listings with new photos or documents waiting.',
    security: signedIn,
    responses: { 200: jsonResponse('The queue', reviewQueueResponseSchema), ...errorResponses(401, 403) },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/vehicles/search',
    tags: ['Admin'],
    summary: 'Every car, to search',
    description:
      'Whatever its status (live, switched off, suspended, draft, under review…), 25 a page, most recently changed first. Each word of `q` must match the year, make, model or variant, the plate, or the Host’s name or email.',
    security: signedIn,
    request: { query: vehicleListQuerySchema },
    responses: {
      200: jsonResponse('The cars', adminVehiclesResponseSchema),
      ...errorResponses(400, 401, 403),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/vehicles/{id}',
    tags: ['Admin'],
    summary: 'A listing to review, with its Host',
    security: signedIn,
    request: { params: idParam },
    responses: { 200: jsonResponse('The listing', adminVehicleSchema), ...errorResponses(401, 403, 404) },
  });

  for (const [action, summary, body] of [
    ['approve', 'Approve a listing (and its pending photos and documents)', reviewNotesSchema],
    ['request-changes', 'Send a listing back to the Host for changes', requiredNotesSchema],
    ['reject', 'Reject a listing', requiredNotesSchema],
  ] as const) {
    registry.registerPath({
      method: 'post',
      path: `/admin/vehicles/{id}/${action}`,
      tags: ['Admin'],
      summary,
      description:
        action === 'approve' ? '409 HOST_NOT_APPROVED until the Host’s application is approved.' : undefined,
      security: signedIn,
      request: { params: idParam, body: jsonBody(body) },
      responses: {
        200: jsonResponse('The listing', hostVehicleResponseSchema),
        ...errorResponses(400, 401, 403, 404, 409),
      },
    });
  }

  registry.registerPath({
    method: 'post',
    path: '/admin/vehicles/{id}/photos/{photoId}',
    tags: ['Admin'],
    summary: 'Approve or reject one photo',
    description: 'A rejected photo counts as missing until the Host replaces it.',
    security: signedIn,
    request: { params: idParam.extend({ photoId: z.string() }), body: jsonBody(photoDecisionSchema) },
    responses: {
      200: jsonResponse('The listing', hostVehicleResponseSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/vehicles/{id}/documents/{documentId}',
    tags: ['Admin'],
    summary: 'Verify or reject one document',
    security: signedIn,
    request: { params: idParam.extend({ documentId: z.string() }), body: jsonBody(documentDecisionSchema) },
    responses: {
      200: jsonResponse('The listing', hostVehicleResponseSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/admin/vehicles/{id}/calendar',
    tags: ['Admin'],
    summary: 'A car’s calendar',
    security: signedIn,
    request: { params: idParam, query: z.object({ from: z.string().optional(), to: z.string().optional() }) },
    responses: {
      200: jsonResponse('The calendar', calendarResponseSchema),
      ...errorResponses(401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/vehicles/{id}/blocks',
    tags: ['Admin'],
    summary: 'Calendar override: block dates',
    description: 'Never over a booking or request (409 BOOKED_DATES). Written to the audit log.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(blockInputSchema) },
    responses: {
      201: jsonResponse('The block', z.object({ block: calendarBlockSchema })),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/admin/vehicles/{id}/blocks/{blockId}',
    tags: ['Admin'],
    summary: 'Calendar override: unblock dates',
    description: 'Staff, Host and recurring blocks; never a trip’s.',
    security: signedIn,
    request: { params: idParam.extend({ blockId: z.string() }) },
    responses: { 204: { description: 'Removed' }, ...errorResponses(401, 403, 404) },
  });
}
