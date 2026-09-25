import { STAFF_ROLES, type Role, type UserDocument } from './user.model.js';

/** The user fields the API returns about the signed-in user. Never includes secrets. */
export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  emailVerified: boolean;
}

export function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roles: [...user.roles],
    emailVerified: Boolean(user.emailVerifiedAt),
  };
}

export function isStaff(roles: readonly Role[]): boolean {
  return roles.some((role) => (STAFF_ROLES as readonly Role[]).includes(role));
}
