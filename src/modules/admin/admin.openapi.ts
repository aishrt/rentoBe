import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponses, jsonResponse, signedIn } from '../../openapi/shared.js';
import { adminOverviewSchema } from './admin.schemas.js';

/**
 * The contract for admin.routes.ts (plan §2.3). Every admin route needs a staff role and the
 * authenticator app set up (403 MFA_SETUP_REQUIRED until it is).
 */
export function registerAdminPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/admin/overview',
    tags: ['Admin'],
    summary: 'KPI figures for the staff portal',
    description: 'Admin and Support only.',
    security: signedIn,
    responses: {
      200: jsonResponse('The overview figures', adminOverviewSchema),
      ...errorResponses(401, 403),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/admin/staff/{id}/mfa/reset',
    tags: ['Admin'],
    summary: "Reset a staff member's lost authenticator",
    description:
      'Admin only, and not for your own account. They are signed out everywhere and set up a new authenticator at their next sign-in. Written to the audit log.',
    security: signedIn,
    request: { params: z.object({ id: z.string().meta({ description: 'The staff member’s user id' }) }) },
    responses: { 204: { description: 'Reset' }, ...errorResponses(401, 403, 404) },
  });
}
