import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { AuthTokenModel } from '../src/modules/auth/auth-token.model.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { FRONTEND_ORIGIN, PASSWORD, browserAgent, createUser, testApp } from './helpers.js';

const post = (path: string, body: object) =>
  request(testApp()).post(`/api/v1${path}`).set('Origin', FRONTEND_ORIGIN).send(body);

async function resetLinkToken(): Promise<string> {
  const job = await JobModel.findOne({ 'payload.template': 'resetPassword' }).sort({ createdAt: -1 });
  const url = (job?.payload as { props?: { resetUrl?: string } } | undefined)?.props?.resetUrl;
  if (!url) throw new Error('No reset email was queued');
  return new URL(url).searchParams.get('token')!;
}

async function signIn(password = PASSWORD) {
  const agent = browserAgent();
  const response = await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password });
  expect(response.status).toBe(200);
  return agent;
}

describe('forgot password', () => {
  it('emails a reset link to an existing account', async () => {
    await createUser();
    const response = await post('/auth/forgot-password', { email: ' KIRI@example.co.nz ' });

    expect(response.status).toBe(204);
    expect(await resetLinkToken()).toBeTruthy();
    expect(await AuthTokenModel.countDocuments({ purpose: 'RESET_PASSWORD' })).toBe(1);
  });

  it('answers the same for an unknown address, and sends nothing', async () => {
    const response = await post('/auth/forgot-password', { email: 'nobody@example.co.nz' });

    expect(response.status).toBe(204);
    expect(await JobModel.countDocuments()).toBe(0);
  });
});

describe('reset password', () => {
  it('sets the new password, signs out everywhere, confirms the email and says so', async () => {
    const user = await createUser();
    await signIn();
    await signIn();
    await post('/auth/forgot-password', { email: 'kiri@example.co.nz' });

    const response = await post('/auth/reset-password', {
      token: await resetLinkToken(),
      password: 'kererū over the bush',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ email: 'kiri@example.co.nz' });
    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(0);
    expect((await UserModel.findById(user._id))?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await JobModel.countDocuments({ 'payload.template': 'passwordChanged' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'password.reset', entityId: user.id })).toBe(1);

    expect((await post('/auth/login', { email: 'kiri@example.co.nz', password: PASSWORD })).status).toBe(401);
    expect(
      (await post('/auth/login', { email: 'kiri@example.co.nz', password: 'kererū over the bush' })).status,
    ).toBe(200);
  });

  it('works once', async () => {
    await createUser();
    await post('/auth/forgot-password', { email: 'kiri@example.co.nz' });
    const token = await resetLinkToken();

    expect((await post('/auth/reset-password', { token, password: 'kererū over the bush' })).status).toBe(
      200,
    );
    const again = await post('/auth/reset-password', { token, password: 'tui sing at dawn!' });
    expect(again.body.error.code).toBe('LINK_INVALID');
  });

  it("keeps the link when the new password isn't allowed, so the visitor can try again", async () => {
    await createUser();
    await post('/auth/forgot-password', { email: 'kiri@example.co.nz' });
    const token = await resetLinkToken();

    const weak = await post('/auth/reset-password', { token, password: 'password123' });
    expect(weak.body.error.fields.password).toMatch(/too common/);
    const ownName = await post('/auth/reset-password', { token, password: 'kiri-is-the-best' });
    expect(ownName.body.error.fields.password).toMatch(/email address/);

    expect((await post('/auth/reset-password', { token, password: 'kererū over the bush' })).status).toBe(
      200,
    );
  });
});

describe('POST /api/v1/me/password', () => {
  it('changes the password and signs out other devices, keeping this one', async () => {
    const user = await createUser();
    const other = await signIn();
    const agent = await signIn();

    const response = await agent
      .post('/api/v1/me/password')
      .send({ currentPassword: PASSWORD, newPassword: 'kererū over the bush' });

    expect(response.status).toBe(204);
    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(1);
    expect((await agent.get('/api/v1/me')).status).toBe(200);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    expect(await JobModel.countDocuments({ 'payload.template': 'passwordChanged' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'password.changed' })).toBe(1);
  });

  it('needs the current password, and a new one that is different', async () => {
    await createUser();
    const agent = await signIn();

    const wrong = await agent
      .post('/api/v1/me/password')
      .send({ currentPassword: 'not it', newPassword: 'kererū over the bush' });
    expect(wrong.body.error.fields).toEqual({ currentPassword: "That's not your current password." });

    // The test password itself is on the common-password list, so move to a strong one first.
    const strong = 'kererū over the bush';
    await agent.post('/api/v1/me/password').send({ currentPassword: PASSWORD, newPassword: strong });
    const same = await agent
      .post('/api/v1/me/password')
      .send({ currentPassword: strong, newPassword: strong });
    expect(same.body.error.fields.newPassword).toMatch(/different/);
  });
});
