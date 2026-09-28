import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponses, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { userResponseSchema } from '../users/user.schemas.js';
import { loginSchema, sessionResponseSchema } from './auth.schemas.js';

/** The contract for auth.routes.ts (plan §2.3). */
export function registerAuthPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'post',
    path: '/auth/login',
    tags: ['Auth'],
    summary: 'Sign in with email and password',
    description:
      'Sets the httpOnly auth cookies. `portal: "admin"` refuses accounts without a staff role. Rate-limited per IP, and sign-in locks for 15 minutes after 5 wrong passwords.',
    request: { body: jsonBody(loginSchema) },
    responses: {
      200: jsonResponse('Signed in', userResponseSchema),
      ...errorResponses(400, 401, 403, 423, 429),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/session',
    tags: ['Auth'],
    summary: 'Who is signed in on this browser',
    description:
      "The website's check on page load. Always 200: `user` is null for a visitor. Renews an expired access token with the refresh cookie in the same call.",
    responses: { 200: jsonResponse('The signed-in user, or null', sessionResponseSchema) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/refresh',
    tags: ['Auth'],
    summary: 'Renew the session',
    description: 'Swaps the refresh cookie for a new pair of cookies. Each refresh token works once.',
    responses: { 200: jsonResponse('Renewed', userResponseSchema), ...errorResponses(401) },
  });

  registry.registerPath({
    method: 'post',
    path: '/auth/logout',
    tags: ['Auth'],
    summary: 'Sign out',
    description: 'Ends the session and clears the auth cookies.',
    responses: { 204: { description: 'Signed out' } },
  });
}
