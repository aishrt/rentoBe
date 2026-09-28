import { z } from 'zod';

/**
 * An error with an HTTP status and a stable machine-readable code.
 * The error handler turns it into `{ error: { code, message, fields } }` (plan §2.3).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthenticated = (message = 'Please sign in to continue.') =>
  new HttpError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = "You don't have access to this.") =>
  new HttpError(403, 'FORBIDDEN', message);

/** The body of every error response (plan §2.3). */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ description: 'Stable machine-readable code, e.g. VALIDATION_ERROR' }),
      message: z.string().meta({ description: 'A message that can be shown to the user' }),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .meta({ description: 'One message per invalid input field' }),
    }),
  })
  .meta({ id: 'ErrorResponse' });
