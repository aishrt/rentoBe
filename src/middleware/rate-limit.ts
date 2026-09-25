import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../lib/http-error.js';

/**
 * Per-IP limit for sign-in attempts. Uses the in-memory store for now; the plan's MongoDB store
 * (shared across backend tasks, section 4.1) replaces it when the rest of auth is built.
 */
export function loginRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(
        new HttpError(
          429,
          'RATE_LIMITED',
          'Too many sign-in attempts. Please wait a few minutes and try again.',
        ),
      ),
  });
}
