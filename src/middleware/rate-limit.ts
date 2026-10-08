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

/** Password-reset emails per IP. */
export const forgotPasswordRateLimit = () =>
  limitRequests({
    name: 'forgot-password',
    windowMs: 15 * MINUTE,
    limit: 5,
    message: 'Too many reset requests. Please check your inbox, or try again in a few minutes.',
  });

/** Authenticator codes at staff sign-in, per IP. Each challenge also allows only 5 wrong codes. */
export const mfaLoginRateLimit = () =>
  limitRequests({
    name: 'mfa-login',
    windowMs: 15 * MINUTE,
    limit: 20,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  });

/** Password and email changes, per user: each one checks the current password. */
export const accountChangeRateLimit = () =>
  limitRequests({
    name: 'account-change',
    windowMs: 60 * MINUTE,
    limit: 10,
    perUser: true,
    message: 'Too many changes in a short time. Please try again in an hour.',
  });

/** SMS codes sent, per user (Twilio Verify also limits each number). */
export const phoneCodeRateLimit = () =>
  limitRequests({
    name: 'phone-code',
    windowMs: 60 * MINUTE,
    limit: 5,
    perUser: true,
    message: "We've sent several codes already. Please try again in an hour.",
  });

/** Codes typed in (phone or authenticator setup), per user. */
export const codeCheckRateLimit = () =>
  limitRequests({
    name: 'code-check',
    windowMs: 15 * MINUTE,
    limit: 10,
    perUser: true,
    message: 'Too many codes tried. Please wait a few minutes and try again.',
  });

/** New bookings per user: each holds a car's dates for 30 minutes (plan §14, risk). */
export const bookingCreateRateLimit = () =>
  limitRequests({
    name: 'booking-create',
    windowMs: 60 * MINUTE,
    limit: 20,
    perUser: true,
    message: "You've started a lot of bookings in a short time. Please try again in an hour.",
  });

/** Contact form messages per IP, against spam (plan §4.1). */
export const contactRateLimit = () =>
  limitRequests({
    name: 'contact',
    windowMs: 60 * MINUTE,
    limit: 5,
    message:
      "You've sent a few messages already. We'll reply soon; please try again in an hour if it's urgent.",
  });

/** Listing maps per IP: each one not in the browser's cache is a paid Google request (plan §1.2). */
export const areaMapRateLimit = () =>
  limitRequests({
    name: 'area-map',
    windowMs: 15 * MINUTE,
    limit: 100,
    message: 'Too many maps in a short time. Please try again in a few minutes.',
  });

/** Replies on a user's own support tickets, per user, against spam. */
export const ticketReplyRateLimit = () =>
  limitRequests({
    name: 'ticket-reply',
    windowMs: 60 * MINUTE,
    limit: 30,
    perUser: true,
    message: "You've sent a lot of messages in a short time. Please try again in an hour.",
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

/** Chat messages, per user, against spam (plan §14, messaging safety). */
export const messageRateLimit = () =>
  limitRequests({
    name: 'message',
    windowMs: 10 * MINUTE,
    limit: 60,
    perUser: true,
    message: "You've sent a lot of messages in a short time. Please wait a few minutes.",
  });

/** Reports of users, messages, reviews and listings, per user. */
export const reportRateLimit = () =>
  limitRequests({
    name: 'report',
    windowMs: 60 * MINUTE,
    limit: 20,
    perUser: true,
    message: "You've sent a lot of reports in a short time. Please try again later.",
  });
