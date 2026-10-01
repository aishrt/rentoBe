import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonBody, jsonResponse, signedIn } from '../../openapi/shared.js';
import { emailResponseSchema } from '../auth/auth.schemas.js';
import {
  acceptStaffInviteSchema,
  staffInviteDetailsSchema,
  staffInviteInputSchema,
  staffInviteResponseSchema,
  staffInviteTokenSchema,
  staffListSchema,
} from './staff.schemas.js';

/**
 * The contract for the staff routes in admin.routes.ts and auth.routes.ts (plan §2.3, §6.2): one
 * admin, set by ADMIN_EMAIL, and a support team who join only by the admin's invitation.
 */
export function registerStaffPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/admin/staff',
    tags: ['Admin'],
    summary: 'The admin, the support team and open invitations',
    description: 'Admin only.',
    security: signedIn,
    responses: { 200: jsonResponse('The staff', staffListSchema), ...errorResponses(401, 403) },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/staff/invites',
    tags: ['Admin'],
    summary: 'Invite someone to the support team',
    description:
      'Admin only. Emails a link that works once for 7 days; inviting the same address again replaces the earlier link. 409 ALREADY_STAFF for the admin’s own email or someone already on the support team. Written to the audit log.',
    security: signedIn,
    request: { body: jsonBody(staffInviteInputSchema) },
    responses: {
      201: jsonResponse('Invitation sent', staffInviteResponseSchema),
      ...errorResponses(400, 401, 403, 409),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/admin/staff/invites/{id}',
    tags: ['Admin'],
    summary: 'Cancel an invitation',
    description: 'Admin only. The link stops working. Written to the audit log.',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The invitation id' }) }) },
    responses: { 204: { description: 'Cancelled' }, ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'delete',
    path: '/admin/staff/{id}',
    tags: ['Admin'],
    summary: 'Take someone off the support team',
    description:
      'Admin only. Removes the Support role, any extra permissions and their authenticator apps, and signs them out everywhere. The account stays, and can be invited again. Written to the audit log.',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The support member’s user id' }) }) },
    responses: { 204: { description: 'Removed' }, ...errorResponses(401, 403, 404) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/staff-invite',
    tags: ['Auth'],
    summary: 'Who a support team invitation is for',
    description:
      'The token from the invitation email. 400 LINK_INVALID when it has expired, was used or was cancelled. Rate-limited per IP.',
    request: { body: jsonBody(staffInviteTokenSchema) },
    responses: {
      200: jsonResponse('The invitation', staffInviteDetailsSchema),
      ...errorResponses(400, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/staff-invite/accept',
    tags: ['Auth'],
    summary: 'Accept a support team invitation with a password',
    description:
      'Creates the support account, or adds Support to the account the email already has (its password is replaced and it’s signed out everywhere). The link confirms the email address. It does not sign in. Rate-limited per IP.',
    request: { body: jsonBody(acceptStaffInviteSchema) },
    responses: {
      200: jsonResponse('Joined the support team', emailResponseSchema),
      ...errorResponses(400, 403, 429),
    },
  });
}
