import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import {
  hostApplicationSchema,
  hostProfilePatchSchema,
  hostProfileResponseSchema,
} from '../hosts/hosts.schemas.js';
import {
  maintenanceInputSchema,
  maintenanceResponseSchema,
  todoResponseSchema,
} from '../hosts/host-reminders.schemas.js';
import { uploadRequestSchema, uploadTargetSchema } from '../uploads/uploads.schemas.js';
import {
  allCarsCalendarQuerySchema,
  allCarsCalendarSchema,
  blockInputSchema,
  calendarBlockSchema,
  calendarResponseSchema,
  documentAttachSchema,
  hostVehicleResponseSchema,
  hostVehiclesResponseSchema,
  photoAttachSchema,
  recurringResultSchema,
  recurringRulesInputSchema,
  vehiclePatchSchema,
} from './host-vehicles.schemas.js';

const idParam = z.object({ id: z.string().meta({ description: 'The car’s id' }) });

/** The contract for hosting: the application, vehicle onboarding, uploads and the calendar. */
export function registerHostPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'post',
    path: '/me/host-application',
    tags: ['Hosting'],
    summary: 'Apply to host',
    description:
      'Needs a verified mobile (409 PHONE_NOT_VERIFIED) and the Host Agreement, whose acceptance is recorded. Adds the HOST role; the Host can add a car straight away, and staff approve the application.',
    security: signedIn,
    request: { body: jsonBody(hostApplicationSchema) },
    responses: {
      200: jsonResponse('The Host profile', hostProfileResponseSchema),
      ...errorResponses(400, 401, 409),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/me/host-profile',
    tags: ['Hosting'],
    summary: 'The Host profile and application status',
    security: signedIn,
    responses: {
      200: jsonResponse('The Host profile', hostProfileResponseSchema),
      ...errorResponses(401, 404),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: '/me/host-profile',
    tags: ['Hosting'],
    summary: 'Update the bio and GST details',
    security: signedIn,
    request: { body: jsonBody(hostProfilePatchSchema) },
    responses: {
      200: jsonResponse('The Host profile', hostProfileResponseSchema),
      ...errorResponses(400, 401, 404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/host/vehicles',
    tags: ['Hosting'],
    summary: 'My Vehicles',
    security: signedIn,
    responses: {
      200: jsonResponse('Every car, newest change first', hostVehiclesResponseSchema),
      ...errorResponses(401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/vehicles',
    tags: ['Hosting'],
    summary: 'Start a new listing (a draft)',
    security: signedIn,
    responses: { 201: jsonResponse('The draft', hostVehicleResponseSchema), ...errorResponses(401, 403) },
  });

  registry.registerPath({
    method: 'get',
    path: '/host/vehicles/{id}',
    tags: ['Hosting'],
    summary: 'One of my cars, with what’s missing',
    security: signedIn,
    request: { params: idParam },
    responses: { 200: jsonResponse('The car', hostVehicleResponseSchema), ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/host/vehicles/{id}',
    tags: ['Hosting'],
    summary: 'Save an onboarding step, or edit a live listing',
    description:
      'Every field is optional. On a live listing, prices, rules and delivery change at once; a new plate, VIN, chassis number, make, model or year sends it back to UNDER_REVIEW. 409 PLATE_TAKEN when the plate is on another listing.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(vehiclePatchSchema) },
    responses: {
      200: jsonResponse('The car', hostVehicleResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/host/vehicles/{id}',
    tags: ['Hosting'],
    summary: 'Delete a draft',
    security: signedIn,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted' }, ...errorResponses(401, 403, 404, 409) },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/vehicles/{id}/photos',
    tags: ['Hosting'],
    summary: 'Add an uploaded photo',
    description: 'It shows on the listing once support staff approve it.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(photoAttachSchema) },
    responses: {
      201: jsonResponse('The car', hostVehicleResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/host/vehicles/{id}/photos/{photoId}',
    tags: ['Hosting'],
    summary: 'Remove a photo',
    security: signedIn,
    request: { params: idParam.extend({ photoId: z.string() }) },
    responses: { 200: jsonResponse('The car', hostVehicleResponseSchema), ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/vehicles/{id}/documents',
    tags: ['Hosting'],
    summary: 'Add an uploaded document',
    security: signedIn,
    request: { params: idParam, body: jsonBody(documentAttachSchema) },
    responses: {
      201: jsonResponse('The car', hostVehicleResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/host/vehicles/{id}/documents/{documentId}',
    tags: ['Hosting'],
    summary: 'Remove a document',
    security: signedIn,
    request: { params: idParam.extend({ documentId: z.string() }) },
    responses: { 200: jsonResponse('The car', hostVehicleResponseSchema), ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/vehicles/{id}/submit',
    tags: ['Hosting'],
    summary: 'Submit a listing for review',
    description: '400 LISTING_INCOMPLETE with one field per missing item until the checklist is complete.',
    security: signedIn,
    request: { params: idParam },
    responses: {
      200: jsonResponse('The car', hostVehicleResponseSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  for (const action of ['activate', 'deactivate'] as const) {
    registry.registerPath({
      method: 'post',
      path: `/host/vehicles/{id}/${action}`,
      tags: ['Hosting'],
      summary: action === 'activate' ? 'Show a listing in search again' : 'Hide a listing from search',
      description: 'Existing bookings stay; the Host cancels them explicitly (plan §8.2).',
      security: signedIn,
      request: { params: idParam },
      responses: {
        200: jsonResponse('The car', hostVehicleResponseSchema),
        ...errorResponses(401, 403, 404, 409),
      },
    });
  }

  registry.registerPath({
    method: 'get',
    path: '/host/vehicles/{id}/calendar',
    tags: ['Hosting'],
    summary: 'The car’s calendar',
    description:
      'Every block with its reason; bookings and requests carry their reference ("Request pending").',
    security: signedIn,
    request: { params: idParam, query: z.object({ from: z.string().optional(), to: z.string().optional() }) },
    responses: {
      200: jsonResponse('The calendar', calendarResponseSchema),
      ...errorResponses(401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/host/calendar',
    tags: ['Hosting'],
    summary: 'The calendar across all my cars',
    description:
      'The Host’s own cars with a calendar (not drafts, rejected or suspended listings), in the order they were added, each with its blocks between two NZ days: up to 62 days at a time. Blocks are as on each car’s own calendar. 400 VALIDATION_ERROR for a longer or backwards range.',
    security: signedIn,
    request: { query: allCarsCalendarQuerySchema },
    responses: {
      200: jsonResponse('Each car’s calendar', allCarsCalendarSchema),
      ...errorResponses(400, 401),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/host/vehicles/{id}/blocks',
    tags: ['Hosting'],
    summary: 'Block dates',
    description: '409 BOOKED_DATES when a booking or request is there.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(blockInputSchema) },
    responses: {
      201: jsonResponse('The block', z.object({ block: calendarBlockSchema }).meta({ id: 'BlockResponse' })),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/host/vehicles/{id}/blocks/{blockId}',
    tags: ['Hosting'],
    summary: 'Unblock dates',
    security: signedIn,
    request: { params: idParam.extend({ blockId: z.string() }) },
    responses: { 204: { description: 'Removed' }, ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'put',
    path: '/host/vehicles/{id}/recurring-rules',
    tags: ['Hosting'],
    summary: 'Set recurring availability',
    description:
      'Replaces the rules, e.g. unavailable every weekday 8:00–18:00 NZ time, and rebuilds 12 months of blocks. Times already booked are skipped and listed.',
    security: signedIn,
    request: { params: idParam, body: jsonBody(recurringRulesInputSchema) },
    responses: {
      200: jsonResponse('The result', recurringResultSchema),
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/uploads/signature',
    tags: ['Hosting'],
    summary: 'Where to upload a photo or document',
    description:
      'The car’s Host (or staff) only. Photos: JPEG, PNG, WebP or HEIC; documents also PDF; up to 15 MB. 503 UPLOADS_UNAVAILABLE until storage is set up in production.',
    security: signedIn,
    request: { body: jsonBody(uploadRequestSchema) },
    responses: {
      200: jsonResponse('The upload target', uploadTargetSchema),
      ...errorResponses(400, 401, 403, 404, 503),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/host/todo',
    tags: ['Hosting'],
    summary: 'The Host’s to-do list',
    description:
      'Payout setup, requests to answer, check-ins due, handovers to confirm, documents expiring within 30 days, Road User Charges and maintenance due, and listings with changes requested. Urgent ones first.',
    security: signedIn,
    responses: { 200: jsonResponse('To do', todoResponseSchema), ...errorResponses(401) },
  });

  const vehicleParams = z.object({ id: z.string() });
  registry.registerPath({
    method: 'get',
    path: '/host/vehicles/{id}/maintenance-reminders',
    tags: ['Hosting'],
    summary: 'A car’s maintenance reminders',
    security: signedIn,
    request: { params: vehicleParams },
    responses: {
      200: jsonResponse('Reminders', maintenanceResponseSchema),
      ...errorResponses(401, 403, 404),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/host/vehicles/{id}/maintenance-reminders',
    tags: ['Hosting'],
    summary: 'Replace a car’s maintenance reminders',
    description:
      'Each is due by a date, an odometer reading, or both. The Host is reminded at 9 am when it’s near.',
    security: signedIn,
    request: { params: vehicleParams, body: jsonBody(maintenanceInputSchema) },
    responses: {
      200: jsonResponse('Saved', maintenanceResponseSchema),
      ...errorResponses(400, 401, 403, 404),
    },
  });
}
