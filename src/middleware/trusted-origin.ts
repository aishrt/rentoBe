import type { RequestHandler } from 'express';
import { env } from '../env.js';
import { HttpError } from '../lib/http-error.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../modules/auth/auth.cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection (plan §14): a request that changes data must come from the frontend's own origin.
 * Browsers always send Origin on cross-site writes, so a request without one is a non-browser client
 * (mobile app, curl); it is allowed only when it carries no auth cookies.
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin) {
    return env.FRONTEND_ORIGINS.includes(origin) ? next() : next(untrusted());
  }

  const hasAuthCookie = Boolean(req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]);
  return hasAuthCookie ? next(untrusted()) : next();
};

const untrusted = () =>
  new HttpError(403, 'UNTRUSTED_ORIGIN', 'This request did not come from a trusted website.');
