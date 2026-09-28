import * as Sentry from '@sentry/node';
import { env } from '../env.js';

/**
 * Error monitoring with Sentry (plan §1.2, §13.5). It gets the errors nobody expected: 500s,
 * jobs that failed for good, and crashes. Expected ones (a wrong password, a 404) are not sent.
 * It only starts in production builds with SENTRY_DSN set; in development and tests reportError does
 * nothing, even when .env has the DSN.
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN || env.NODE_ENV !== 'production') return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    // "production" or, later, "staging": both run with NODE_ENV=production.
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    release: env.RELEASE,
    // Stack traces and our own tags only: no user details, cookies, headers, bodies, query strings,
    // or the values of local variables (they can hold passwords and tokens). NZ Privacy Act, plan §14.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Errors only: request timings and load are watched in CloudWatch (plan §13.1).
  });
}

export interface ErrorContext {
  /** Short values Sentry can search and group by, e.g. the route or job type. */
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export function reportError(error: unknown, context: ErrorContext = {}): void {
  Sentry.captureException(error, context);
}

/** Sends anything still queued, so errors just before a shutdown or crash aren't lost. */
export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  await Sentry.flush(timeoutMs);
}
