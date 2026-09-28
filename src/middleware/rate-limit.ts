import type { Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../lib/http-error.js';
import { MongoRateLimitStore } from './rate-limit-store.js';

interface LimitOptions {
  /** Keeps each limit's counters apart in the shared store. */
  name: string;
  windowMs: number;
  limit: number;
  message: string;
  /** Count per signed-in user instead of per IP. Needs requireAuth before it. */
  perUser?: boolean;
}

const MINUTE = 60 * 1000;

/** A limit counted across every backend task (plan §4.1), answering 429 with the standard error body. */
function limitRequests({ name, windowMs, limit, message, perUser }: LimitOptions) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new MongoRateLimitStore(name),
    ...(perUser && { keyGenerator: (req: Request) => `user:${req.auth?.userId ?? 'unknown'}` }),
    handler: (_req, _res, next) => next(new HttpError(429, 'RATE_LIMITED', message)),
  });
}

/** Sign-in attempts per IP. Wrong passwords also lock the account (auth.service.ts). */
export const loginRateLimit = () =>
  limitRequests({
    name: 'login',
    windowMs: 15 * MINUTE,
    limit: 20,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  });

/** New accounts per IP, against bulk sign-ups. */
export const signupRateLimit = () =>
  limitRequests({
    name: 'signup',
    windowMs: 60 * MINUTE,
    limit: 10,
    message: 'Too many new accounts from this network. Please try again in an hour.',
  });

/** Emailed links checked per IP (confirm email, reset password). */
export const emailLinkRateLimit = () =>
  limitRequests({
    name: 'email-link',
    windowMs: 15 * MINUTE,
    limit: 30,
    message: 'Too many attempts. Please wait a few minutes and try again.',
  });

/** Emails a user can ask us to send again, per user. */
export const resendEmailRateLimit = () =>
  limitRequests({
    name: 'resend-email',
    windowMs: 60 * MINUTE,
    limit: 5,
    perUser: true,
    message:
      "We've sent a few emails already. Please check your inbox and spam folder, or try again in an hour.",
  });
