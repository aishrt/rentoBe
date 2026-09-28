import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { FRONTEND_ORIGIN, PASSWORD, browserAgent, createUser, testApp } from './helpers.js';

async function signIn() {
  const agent = browserAgent();
  await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });
  return agent;
}

async function queuedEmail(template: string) {
  const job = await JobModel.findOne({ 'payload.template': template }).sort({ createdAt: -1 });
  return job?.payload as { to: string; props: Record<string, string> } | undefined;
}

const confirm = (token: string) =>
  request(testApp()).post('/api/v1/auth/confirm-email-change').set('Origin', FRONTEND_ORIGIN).send({ token });

describe('changing the email address', () => {
  it('sends a link to the new address, and switches only once it is opened', async () => {
    const user = await createUser();
    const agent = await signIn();

    const response = await agent
      .post('/api/v1/me/email')
      .send({ newEmail: 'Kiri.New@Example.co.nz', currentPassword: PASSWORD });
    expect(response.body).toEqual({ email: 'kiri.new@example.co.nz' });

    const email = await queuedEmail('confirmEmailChange');
    expect(email?.to).toBe('kiri.new@example.co.nz');
    // Until the link is opened, the old address is still the account's.
    expect((await UserModel.findById(user._id))?.email).toBe('kiri@example.co.nz');

    const token = new URL(email!.props.confirmUrl!).searchParams.get('token')!;
    const confirmed = await confirm(token);
    expect(confirmed.body).toEqual({ email: 'kiri.new@example.co.nz' });

    const saved = await UserModel.findById(user._id);
    expect(saved?.email).toBe('kiri.new@example.co.nz');
    expect(saved?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await queuedEmail('emailChanged'))?.to).toBe('kiri@example.co.nz');
    expect(await AuditLogModel.findOne({ action: 'email.changed' }).lean()).toMatchObject({
      before: { email: 'kiri@example.co.nz' },
      after: { email: 'kiri.new@example.co.nz' },
    });
    expect((await confirm(token)).body.error.code).toBe('LINK_INVALID');
  });

  it('needs the current password', async () => {
    await createUser();
    const response = await (
      await signIn()
    )
      .post('/api/v1/me/email')
      .send({ newEmail: 'kiri.new@example.co.nz', currentPassword: 'not it' });

    expect(response.body.error.fields).toEqual({ currentPassword: "That's not your current password." });
    expect(await queuedEmail('confirmEmailChange')).toBeUndefined();
  });

  it('refuses an address that already has an account', async () => {
    await createUser({ email: 'hana@example.co.nz' });
    await createUser();

    const response = await (
      await signIn()
    )
      .post('/api/v1/me/email')
      .send({ newEmail: 'hana@example.co.nz', currentPassword: PASSWORD });
    expect(response.status).toBe(409);
    expect(response.body.error.fields).toHaveProperty('newEmail');
  });
});
