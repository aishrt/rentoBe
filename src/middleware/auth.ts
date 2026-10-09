import type { Request, RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/http-error.js';
import { ACCESS_COOKIE } from '../modules/auth/auth.cookies.js';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import { UserModel, type Permission, type Role } from '../modules/users/user.model.js';
import { effectiveRoles } from '../modules/users/user.service.js';

/** Browsers send the access token as a cookie; future mobile apps send it as a Bearer header (plan §6.1). */
export function readAccessToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const cookie: unknown = req.cookies?.[ACCESS_COOKIE];
  return typeof cookie === 'string' ? cookie : undefined;
}

/** Reads the session when there is one, for routes that also work signed out (the contact form). */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readAccessToken(req);
  const auth = token ? verifyAccessToken(token) : null;
  if (auth) req.auth = auth;
  next();
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Suspending or closing an account deletes its sessions, but its access token stays valid for up to
 * 15 minutes. Reads may finish that time; every change is refused at once (plan §8.2: a suspended user's
 * messages, bookings and listings stop straight away). Closed accounts are suspended too.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = readAccessToken(req);
  const auth = token ? verifyAccessToken(token) : null;
  if (!auth) return next(unauthenticated());
  if (!READ_METHODS.has(req.method)) {
    try {
      const user = await UserModel.findById(auth.userId).select('status').lean();
      if (!user || user.status !== 'ACTIVE') return next(unauthenticated());
    } catch (error) {
      return next(error);
    }
  }
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
    const user = await UserModel.findById(req.auth.userId).select('email roles permissions status');
    if (!user || user.status !== 'ACTIVE') return next(unauthenticated());
    if (!effectiveRoles(user).includes('ADMIN') && !user.permissions.includes(permission)) {
      return next(forbidden());
    }
    next();
  };
}

/** The same check inside a route, for an action that needs the permission only sometimes. */
export async function hasPermission(userId: string, permission: Permission): Promise<boolean> {
  const user = await UserModel.findById(userId).select('email roles permissions status');
  if (!user || user.status !== 'ACTIVE') return false;
  return effectiveRoles(user).includes('ADMIN') || user.permissions.includes(permission);
}

/**
 * Refuses an account suspended or removed since its access token was issued, for the staff portal,
 * and replaces the token's roles with the account's current ones: a support member removed from the
 * team, or an admin whose email is no longer ADMIN_EMAIL, loses access at once rather than when the
 * token expires. Two-factor sign-in is each staff member's choice (plan §6.1); staff who turned it on
 * can only sign in with a code, so their sessions reaching here passed it. Must run after requireAuth.
 */
export const requireActiveAccount: RequestHandler = async (req, _res, next) => {
  if (!req.auth) return next(unauthenticated());
  const user = await UserModel.findById(req.auth.userId).select('email roles status');
  if (!user || user.status !== 'ACTIVE') return next(unauthenticated());
  req.auth.roles = effectiveRoles(user);
  next();
};
