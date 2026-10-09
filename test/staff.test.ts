import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { signAccessToken } from '../src/modules/auth/auth.tokens.js';
import { StaffInviteModel } from '../src/modules/staff/staff-invite.model.js';
import {
  staffInviteDetailsSchema,
  staffInviteResponseSchema,
  staffListSchema,
} from '../src/modules/staff/staff.schemas.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

// ADMIN_EMAIL is aroha@example.co.nz in tests (vitest.config.ts), the default of createStaff().
const NEW_PASSWORD = 'kea on the ridge at noon';

async function signedInAs(email: string, portal: 'app' | 'admin' = 'app') {
  const agent = browserAgent();
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD, portal });
  return { agent, login };
}

type Agent = Awaited<ReturnType<typeof staffAgent>>;

/** The admin invites someone; returns the token from the emailed link. */
async function invite(admin: Agent, email = 'mere@example.co.nz', firstName = 'Mere') {
  const response = await admin
    .post('/api/v1/admin/staff/invites')
    .send({ email, firstName, lastName: 'Support' });
  expect(response.status).toBe(201);
  const job = await JobModel.findOne({ type: 'email.send', 'payload.template': 'staffInvite' })
    .sort({ _id: -1 })
    .lean();
  const url = new URL((job!.payload as { props: { acceptUrl: string } }).props.acceptUrl);
  expect(url.pathname).toBe('/admin/invite');
  return { response, token: url.searchParams.get('token')! };
}

describe('the one admin (ADMIN_EMAIL)', () => {
  it('ignores the ADMIN role on any other account, at sign-in and in the session', async () => {
    await createUser({ email: 'mallory@example.co.nz', roles: ['GUEST', 'ADMIN'] });

    const portal = await signedInAs('mallory@example.co.nz', 'admin');
    expect(portal.login.status).toBe(403);
    expect(portal.login.body.error.code).toBe('NOT_STAFF');

    const { agent, login } = await signedInAs('mallory@example.co.nz');
    expect(login.body.user.roles).toEqual(['GUEST']);
    expect((await agent.get('/api/v1/admin/overview')).status).toBe(403);
  });

  it('refuses a signed token that claims ADMIN for another account', async () => {
    const mallory = await createUser({ email: 'mallory@example.co.nz', roles: ['ADMIN'] });
    const token = signAccessToken({ userId: mallory.id, roles: ['ADMIN'], sessionId: 'session' });

    const response = await request(testApp())
      .get('/api/v1/admin/staff')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
  });

  it('counts only the real admin and the support team as staff', async () => {
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    await createUser({ email: 'mallory@example.co.nz', roles: ['ADMIN'] });

    const overview = await (await staffAgent()).get('/api/v1/admin/overview');
    expect(overview.body.metrics.staffMembers).toBe(2);
  });

  it('is never created by sign-up, whatever the form sends', async () => {
    const response = await browserAgent()
      .post('/api/v1/auth/signup')
      .send({
        firstName: 'Mallory',
        lastName: 'Tester',
        email: 'mallory@example.co.nz',
        password: 'tui sing at dawn',
        acceptTerms: true,
        roles: ['ADMIN', 'SUPPORT'],
      });
    expect(response.status).toBe(201);
    expect(response.body.user.roles).toEqual(['GUEST']);
  });
});

describe('support team invitations', () => {
  it('lets the admin invite someone, who chooses a password and can then log in to the staff portal', async () => {
    const admin = await createStaff();
    const { response, token } = await invite(await staffAgent());
    expect(staffInviteResponseSchema.parse(response.body).invite).toMatchObject({
      email: 'mere@example.co.nz',
      firstName: 'Mere',
    });

    const details = await browserAgent().post('/api/v1/auth/staff-invite').send({ token });
    expect(staffInviteDetailsSchema.parse(details.body)).toEqual({
      email: 'mere@example.co.nz',
      firstName: 'Mere',
      existingAccount: false,
    });

    const accepted = await browserAgent()
      .post('/api/v1/auth/staff-invite/accept')
      .send({ token, password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ email: 'mere@example.co.nz' });

    const mere = await UserModel.findOne({ email: 'mere@example.co.nz' });
    expect(mere?.roles).toEqual(['SUPPORT']);
    expect(mere?.emailVerifiedAt).toBeInstanceOf(Date);

    const login = await browserAgent()
      .post('/api/v1/auth/login')
      .send({ email: 'mere@example.co.nz', password: NEW_PASSWORD, portal: 'admin' });
    expect(login.status).toBe(200);
    expect(login.body.user.roles).toEqual(['SUPPORT']);

    const actions = (await AuditLogModel.find().lean()).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['staff.invite', 'staff.join']));
    const sent = await AuditLogModel.findOne({ action: 'staff.invite' }).lean();
    expect(String(sent?.actorId)).toBe(admin.id);
  });

  it('works once, and stops working when cancelled or expired', async () => {
    await createStaff();
    const admin = await staffAgent();
    const first = await invite(admin);
    await browserAgent()
      .post('/api/v1/auth/staff-invite/accept')
      .send({ token: first.token, password: NEW_PASSWORD });
    const again = await browserAgent()
      .post('/api/v1/auth/staff-invite/accept')
      .send({ token: first.token, password: NEW_PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('LINK_INVALID');

    const cancelled = await invite(admin, 'tama@example.co.nz', 'Tama');
    const id = cancelled.response.body.invite.id as string;
    expect((await admin.delete(`/api/v1/admin/staff/invites/${id}`)).status).toBe(204);
    const afterCancel = await browserAgent()
      .post('/api/v1/auth/staff-invite')
      .send({ token: cancelled.token });
    expect(afterCancel.body.error.code).toBe('LINK_INVALID');

    const expired = await invite(admin, 'hana@example.co.nz', 'Hana');
    await StaffInviteModel.updateOne(
      { email: 'hana@example.co.nz' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const afterExpiry = await browserAgent()
      .post('/api/v1/auth/staff-invite/accept')
      .send({ token: expired.token, password: NEW_PASSWORD });
    expect(afterExpiry.body.error.code).toBe('LINK_INVALID');
    expect(await UserModel.exists({ email: 'hana@example.co.nz' })).toBeNull();
  });

  it('replaces the earlier link when the same address is invited again', async () => {
    await createStaff();
    const admin = await staffAgent();
    const first = await invite(admin);
    const second = await invite(admin);
    expect(await StaffInviteModel.countDocuments()).toBe(1);

    const old = await browserAgent().post('/api/v1/auth/staff-invite').send({ token: first.token });
    expect(old.body.error.code).toBe('LINK_INVALID');
    const current = await browserAgent().post('/api/v1/auth/staff-invite').send({ token: second.token });
    expect(current.status).toBe(200);
  });

  it("refuses the admin's own email and someone already on the support team", async () => {
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    const admin = await staffAgent();

    for (const email of ['aroha@example.co.nz', 'sam@example.co.nz']) {
      const response = await admin
        .post('/api/v1/admin/staff/invites')
        .send({ email, firstName: 'Someone', lastName: 'Else' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ALREADY_STAFF');
    }
    expect(await StaffInviteModel.countDocuments()).toBe(0);
  });

  it('adds Support to an account the email already has, with the new password, signing it out', async () => {
    await createStaff();
    const kiri = await createUser({ roles: ['GUEST'] });
    await signedInAs('kiri@example.co.nz');
    const { token } = await invite(await staffAgent(), 'kiri@example.co.nz', 'Kiri');

    const details = await browserAgent().post('/api/v1/auth/staff-invite').send({ token });
    expect(details.body.existingAccount).toBe(true);
    await browserAgent().post('/api/v1/auth/staff-invite/accept').send({ token, password: NEW_PASSWORD });

    expect((await UserModel.findById(kiri._id))?.roles).toEqual(['GUEST', 'SUPPORT']);
    expect(await SessionModel.countDocuments({ userId: kiri._id })).toBe(0);
    const login = await browserAgent()
      .post('/api/v1/auth/login')
      .send({ email: 'kiri@example.co.nz', password: NEW_PASSWORD, portal: 'admin' });
    expect(login.status).toBe(200);
  });

  it("doesn't take a password that uses the email name, and keeps the link for another try", async () => {
    await createStaff();
    const { token } = await invite(await staffAgent());

    const refused = await browserAgent()
      .post('/api/v1/auth/staff-invite/accept')
      .send({ token, password: 'mere-support-2026' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.fields).toHaveProperty('password');

    const accepted = await browserAgent()
      .post('/api/v1/auth/staff-invite/accept')
      .send({ token, password: NEW_PASSWORD });
    expect(accepted.status).toBe(200);
  });

  it('is for the admin only: not support staff, Guests or visitors', async () => {
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    await createUser({ roles: ['GUEST', 'HOST'] });
    const support = await staffAgent('sam@example.co.nz');
    const { agent: guest } = await signedInAs('kiri@example.co.nz');
    const body = { email: 'mere@example.co.nz', firstName: 'Mere', lastName: 'Support' };

    for (const agent of [support, guest]) {
      expect((await agent.post('/api/v1/admin/staff/invites').send(body)).status).toBe(403);
      expect((await agent.get('/api/v1/admin/staff')).status).toBe(403);
    }
    expect((await request(testApp()).get('/api/v1/admin/staff')).status).toBe(401);
    expect(await StaffInviteModel.countDocuments()).toBe(0);
  });
});

describe('GET /api/v1/admin/staff and DELETE /api/v1/admin/staff/:id', () => {
  it('lists the admin first, then the support team, and the open invitations', async () => {
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    await createUser({ email: 'mallory@example.co.nz', roles: ['ADMIN'] });
    const admin = await staffAgent();
    await invite(admin);

    const list = staffListSchema.parse((await admin.get('/api/v1/admin/staff')).body);
    expect(list.staff.map((member) => [member.email, member.role])).toEqual([
      ['aroha@example.co.nz', 'ADMIN'],
      ['sam@example.co.nz', 'SUPPORT'],
    ]);
    expect(list.invites.map((open) => open.email)).toEqual(['mere@example.co.nz']);
  });

  it('shows each member’s permissions: the admin has them all, support only what the admin gave', async () => {
    await createStaff();
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    const admin = await staffAgent();
    const permissions = async () =>
      staffListSchema
        .parse((await admin.get('/api/v1/admin/staff')).body)
        .staff.map((member) => [member.email, member.permissions]);

    expect(await permissions()).toEqual([
      ['aroha@example.co.nz', ['REFUNDS']],
      ['sam@example.co.nz', []],
    ]);
    await admin.post(`/api/v1/admin/staff/${sam.id}/permissions`).send({ refunds: true });
    expect(await permissions()).toEqual([
      ['aroha@example.co.nz', ['REFUNDS']],
      ['sam@example.co.nz', ['REFUNDS']],
    ]);
  });

  it('takes someone off the support team at once, and they can be invited again', async () => {
    await createStaff();
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    const samAgent = await staffAgent('sam@example.co.nz');
    expect((await samAgent.get('/api/v1/admin/overview')).status).toBe(200);

    const admin = await staffAgent();
    expect((await admin.delete(`/api/v1/admin/staff/${sam.id}`)).status).toBe(204);

    const removed = await UserModel.findById(sam._id);
    expect(removed?.roles).toEqual([]);
    expect(removed?.mfa).toBeUndefined();
    expect(await SessionModel.countDocuments({ userId: sam._id })).toBe(0);
    // The access token is still valid for a few minutes, but the account's roles are read again.
    expect((await samAgent.get('/api/v1/admin/overview')).status).toBe(403);

    const again = await admin
      .post('/api/v1/admin/staff/invites')
      .send({ email: 'sam@example.co.nz', firstName: 'Sam', lastName: 'Support' });
    expect(again.status).toBe(201);
  });

  it("only removes support team members, so the admin can't be removed", async () => {
    const aroha = await createStaff();
    const admin = await staffAgent();
    expect((await admin.delete(`/api/v1/admin/staff/${aroha.id}`)).status).toBe(404);
    expect((await admin.delete('/api/v1/admin/staff/not-an-id')).status).toBe(404);
  });
});
