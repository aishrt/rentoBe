import type { RequestHandler } from 'express';
import { env } from '../env.js';
import { HttpError } from '../lib/http-error.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../modules/auth/auth.cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection (plan §14), shared by API writes and Socket.IO connections. A request from a
 * browser must come from the frontend's own origin. Browsers always send Origin on these requests,
 * so a request without one is a non-browser client (mobile app, curl); it is allowed only when it
 * carries no auth cookies.
 */
export function isTrustedOrigin(origin: string | undefined, hasAuthCookie: boolean): boolean {
  if (origin) return env.FRONTEND_ORIGINS.includes(origin);
  return !hasAuthCookie;
}

export function hasAuthCookie(cookies: Record<string, unknown> | undefined): boolean {
  return Boolean(cookies?.[ACCESS_COOKIE] || cookies?.[REFRESH_COOKIE]);
}

/** Every request that changes data must pass isTrustedOrigin(). */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  return isTrustedOrigin(req.get('origin'), hasAuthCookie(req.cookies)) ? next() : next(untrusted());
};

const untrusted = () =>
  new HttpError(403, 'UNTRUSTED_ORIGIN', 'This request did not come from a trusted website.');
