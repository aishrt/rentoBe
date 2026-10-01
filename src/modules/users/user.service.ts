import { env } from '../../env.js';
import { pendingAgreements } from './agreements.js';
import { STAFF_ROLES, type Role, type User, type UserDocument } from './user.model.js';
import type { PublicUser } from './user.schemas.js';

export type { PublicUser };

/**
 * The roles an account really has. There is one admin (plan §6.2): the ADMIN role only counts on the
 * account whose email is ADMIN_EMAIL, and is ignored on any other. Everything that hands out or checks
 * roles goes through this: the access token, the session's user and the staff checks.
 */
export function effectiveRoles(user: Pick<User, 'email' | 'roles'>): Role[] {
  return user.roles.filter((role) => role !== 'ADMIN' || user.email === env.ADMIN_EMAIL);
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roles: effectiveRoles(user),
    emailVerified: Boolean(user.emailVerifiedAt),
    ...(user.phone && { phone: user.phone }),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    mfaEnabled: Boolean(user.mfa?.enabledAt),
    hostStatus: user.hostProfile?.status ?? null,
    pendingAgreements: pendingAgreements(user),
  };
}

export function isStaff(roles: readonly Role[]): boolean {
  return roles.some((role) => (STAFF_ROLES as readonly Role[]).includes(role));
}
