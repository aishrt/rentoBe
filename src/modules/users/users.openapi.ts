import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponses, jsonResponse, signedIn } from '../../openapi/shared.js';
import { userResponseSchema } from './user.schemas.js';

/** The contract for users.routes.ts (plan §2.3). */
export function registerUserPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/me',
    tags: ['Account'],
    summary: 'The signed-in user',
    security: signedIn,
    responses: { 200: jsonResponse('The signed-in user', userResponseSchema), ...errorResponses(401) },
  });
}
