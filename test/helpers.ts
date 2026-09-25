import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { UserModel, type Role, type UserStatus } from '../src/modules/users/user.model.js';

export const FRONTEND_ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

let passwordHash: Promise<string> | undefined;

export async function createUser(
  overrides: Partial<{ email: string; roles: Role[]; status: UserStatus; firstName: string }> = {},
) {
  passwordHash ??= hashPassword(PASSWORD);
  return UserModel.create({
    email: 'kiri@example.co.nz',
    firstName: 'Kiri',
    lastName: 'Tester',
    roles: ['GUEST'],
    passwordHash: await passwordHash,
    ...overrides,
  });
}

export function testApp() {
  return createApp({ rateLimit: false });
}

/** A cookie-keeping client that sends the frontend's Origin, like the website does. */
export function browserAgent() {
  return request.agent(testApp()).set('Origin', FRONTEND_ORIGIN);
}

export function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}
