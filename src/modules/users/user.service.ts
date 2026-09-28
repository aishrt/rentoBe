import { STAFF_ROLES, type Role, type UserDocument } from './user.model.js';
import type { PublicUser } from './user.schemas.js';

export type { PublicUser };

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roles: [...user.roles],
    emailVerified: Boolean(user.emailVerifiedAt),
    ...(user.phone && { phone: user.phone }),
    phoneVerified: Boolean(user.phoneVerifiedAt),
    mfaEnabled: Boolean(user.mfa?.enabledAt),
  };
}

export function isStaff(roles: readonly Role[]): boolean {
  return roles.some((role) => (STAFF_ROLES as readonly Role[]).includes(role));
}
