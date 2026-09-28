import type { Request, RequestHandler } from 'express';
import { HttpError, forbidden, unauthenticated } from '../lib/http-error.js';
import { ACCESS_COOKIE } from '../modules/auth/auth.cookies.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import { UserModel, type Permission, type Role } from '../modules/users/user.model.js';

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

/**
 * Must run after requireAuth. Admins have every permission; anyone else needs this one on their account,
 * e.g. support staff with REFUNDS (plan §6.2). Permissions aren't in the access token, so they're read
 * each time and a removed permission stops working at once. It also refuses a suspended account.
 */
export function requirePermission(permission: Permission): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) return next(unauthenticated());
    const user = await UserModel.findById(req.auth.userId).select('roles permissions status');
    if (!user || user.status !== 'ACTIVE') return next(unauthenticated());
    if (!user.roles.includes('ADMIN') && !user.permissions.includes(permission)) return next(forbidden());
    next();
  };
}

/**
 * The staff portal opens only once the staff member's authenticator app is set up (plan §6.1).
 * Staff with one set up can only sign in with its code, so every session reaching here passed it.
 * Must run after requireAuth; it also refuses an account suspended since its token was issued.
 */
export const requireStaffMfa: RequestHandler = async (req, _res, next) => {
  const user = await UserModel.findById(req.auth?.userId).select('status mfa.enabledAt');
  if (!user || user.status !== 'ACTIVE') return next(unauthenticated());
  if (!user.mfa?.enabledAt) {
    return next(
      new HttpError(403, 'MFA_SETUP_REQUIRED', 'Set up your authenticator app to open the staff portal.'),
    );
  }
  next();
};
