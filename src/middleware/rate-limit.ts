import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../lib/http-error.js';
import { MongoRateLimitStore } from './rate-limit-store.js';

/** Per-IP limit for sign-in attempts, counted across every backend task (plan §4.1). */
export function loginRateLimit() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new MongoRateLimitStore('login'),
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
