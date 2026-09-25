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
