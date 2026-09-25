import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../env.js';
import { ROLES, type Role } from '../users/user.model.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ISSUER = 'rento-vroom';
const AUDIENCE = 'rento-vroom-api';

/** Who is making the request, taken from a verified access token. */
export interface AuthContext {
  userId: string;
  roles: Role[];
  sessionId: string;
}

export function signAccessToken({ userId, roles, sessionId }: AuthContext): string {
  return jwt.sign({ roles, sid: sessionId }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/** Returns the auth context, or null when the token is missing, expired or invalid. */
export function verifyAccessToken(token: string): AuthContext | null {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload === 'string' || !payload.sub || typeof payload.sid !== 'string') return null;

    const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((role): role is Role => (ROLES as readonly string[]).includes(role))
      : [];
    return { userId: payload.sub, roles, sessionId: payload.sid };
  } catch {
    return null;
  }
}

export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
