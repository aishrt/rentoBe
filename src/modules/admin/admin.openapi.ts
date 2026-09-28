import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponses, jsonResponse, signedIn } from '../../openapi/shared.js';
import { adminOverviewSchema } from './admin.schemas.js';

/** The contract for admin.routes.ts (plan §2.3). */
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
}
