import type { Request, RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/http-error.js';
import { ACCESS_COOKIE } from '../modules/auth/auth.cookies.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import type { Role } from '../modules/users/user.model.js';

/** Browsers send the access token as a cookie; future mobile apps send it as a Bearer header (plan §6.1). */
export function readAccessToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const cookie: unknown = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === 'string' ? cookie : undefined;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readAccessToken(req);
  const auth = token ? verifyAccessToken(token) : null;
  if (!auth) return next(unauthenticated());
  req.auth = auth;
  next();
};

/** Must run after requireAuth. The API is the real security boundary; the frontend guards only hide pages. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    if (!req.auth.roles.some((role) => roles.includes(role))) return next(forbidden());
    next();
  };
}
