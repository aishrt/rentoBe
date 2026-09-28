import { generate } from 'otplib';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/lib/encryption.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';
import { UserModel, type Role, type UserStatus } from '../src/modules/users/user.model.js';

export const FRONTEND_ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';
/** The authenticator secret of staff made by createStaff(). */
export const STAFF_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

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

/** A staff member whose authenticator app is set up, with STAFF_TOTP_SECRET. */
export async function createStaff(email = 'aroha@example.co.nz', role: Role = 'ADMIN') {
  const user = await createUser({ email, roles: [role], firstName: 'Aroha' });
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { mfa: { secret: encrypt(STAFF_TOTP_SECRET), enabledAt: new Date() } } },
  );
  return user;
}

/**
 * A valid, unused authenticator code for a staff member's STAFF_TOTP_SECRET. Each code works once,
 * so after one has been used this gives the next 30-second step's (the server accepts one step ahead).
 */
export async function staffCode(email = 'aroha@example.co.nz'): Promise<string> {
  const user = await UserModel.findOne({ email });
  const now = Math.floor(Date.now() / 30_000);
  const last = user?.mfa?.lastTimeStep;
  const step = last === undefined || last < now ? now : last + 1;
  return generate({ secret: STAFF_TOTP_SECRET, epoch: step * 30 });
}

export function testApp() {
  return createApp({ rateLimit: false });
}

/** A cookie-keeping client that sends the frontend's Origin, like the website does. */
export function browserAgent() {
  return request.agent(testApp()).set('Origin', FRONTEND_ORIGIN);
}

/** A browser signed in as a staff member made by createStaff(), through the authenticator step. */
export async function staffAgent(email = 'aroha@example.co.nz') {
  const agent = browserAgent();
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD, portal: 'admin' });
  expect(login.body.mfaRequired).toBe(true);
  const done = await agent
    .post('/api/v1/auth/login/mfa')
    .send({ challenge: login.body.challenge, code: await staffCode(email) });
  expect(done.status).toBe(200);
  return agent;
}

export function setCookieHeaders(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (!header) return [];
  return Array.isArray(header) ? header : [header];
}
