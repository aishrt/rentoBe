import type { ResponseConfig, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import { errorResponseSchema } from '../lib/http-error.js';

type Responses = Record<number, ResponseConfig>;

export const jsonBody = (schema: z.ZodType): NonNullable<RouteConfig['request']>['body'] => ({
  required: true,
  content: { 'application/json': { schema } },
});

export const jsonResponse = (description: string, schema: z.ZodType): ResponseConfig => ({
  description,
  content: { 'application/json': { schema } },
});

const ERRORS: Record<number, string> = {
  400: 'Invalid input. `error.fields` has one message per invalid field.',
  401: 'Not signed in, or the session has ended',
  403: "Signed in, but this account can't do this (or the request came from an untrusted origin)",
  409: 'Conflicts with existing data, e.g. the email address already has an account',
  423: 'Sign-in is paused after too many wrong passwords',
  429: 'Too many requests; try again later',
};

/** The documented error responses of a route, each with the standard `{ error }` body. */
export function errorResponses(...statuses: (keyof typeof ERRORS)[]): Responses {
  return Object.fromEntries(
    statuses.map((status) => [status, jsonResponse(ERRORS[status]!, errorResponseSchema)]),
  );
}

/** Routes that need a signed-in user: the access cookie from the website, or a Bearer token from an app. */
export const signedIn: RouteConfig['security'] = [{ cookieAuth: [] }, { bearerAuth: [] }];
