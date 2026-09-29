import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

async function signedInAs(email: string) {
  const agent = browserAgent();
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return agent;
}

describe('GET /api/v1/admin/overview', () => {
  it('needs a signed-in user', async () => {
    const response = await request(testApp()).get('/api/v1/admin/overview');
    expect(response.status).toBe(401);
  });

  it('is forbidden for guests and hosts', async () => {
    await createUser({ roles: ['GUEST', 'HOST'] });
    const agent = await signedInAs('kiri@example.co.nz');

    const response = await agent.get('/api/v1/admin/overview');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it("opens to staff who haven't turned on two-factor sign-in, but not once they're suspended", async () => {
    const staff = await createUser({ email: 'aroha@example.co.nz', roles: ['SUPPORT'] });
    const agent = await signedInAs('aroha@example.co.nz');
    expect((await agent.get('/api/v1/admin/overview')).status).toBe(200);

    await UserModel.updateOne({ _id: staff._id }, { $set: { status: 'SUSPENDED' } });
    expect((await agent.get('/api/v1/admin/overview')).status).toBe(401);
  });

  it('returns real user counts to staff, and null for metrics not tracked yet', async () => {
    await createStaff('aroha@example.co.nz', 'ADMIN');
    await createStaff('sam@example.co.nz', 'SUPPORT');
    await createUser({ email: 'hana@example.co.nz', roles: ['GUEST', 'HOST'] });
    await createUser({ email: 'kiri@example.co.nz', roles: ['GUEST'] });
    await createUser({ email: 'tama@example.co.nz', roles: ['GUEST'], status: 'SUSPENDED' });

    for (const email of ['aroha@example.co.nz', 'sam@example.co.nz']) {
      const response = await (await staffAgent(email)).get('/api/v1/admin/overview');
      expect(response.status).toBe(200);
      expect(response.body.metrics).toEqual({
        totalUsers: 3,
        activeHosts: 1,
        staffMembers: 2,
        suspendedUsers: 1,
        activeVehicles: null,
        upcomingBookings: null,
        bookingRevenueCents: null,
        pendingVerifications: null,
      });
    }
  });
});

describe('POST /api/v1/admin/staff/:id/mfa/reset', () => {
  it("lets an admin reset another staff member's authenticator, signing them out, with an audit entry", async () => {
    const admin = await createStaff('aroha@example.co.nz', 'ADMIN');
    const support = await createStaff('sam@example.co.nz', 'SUPPORT');
    await staffAgent('sam@example.co.nz');
    expect(await SessionModel.countDocuments({ userId: support._id })).toBe(1);

    const response = await (await staffAgent()).post(`/api/v1/admin/staff/${support.id}/mfa/reset`);

    expect(response.status).toBe(204);
    expect((await UserModel.findById(support._id))?.mfa).toBeUndefined();
    expect(await SessionModel.countDocuments({ userId: support._id })).toBe(0);
    const entries = await AuditLogModel.find({ entityId: support.id }).lean();
    expect(entries.map((entry) => entry.action).sort()).toEqual(
      ['POST /api/v1/admin/staff/:id/mfa/reset', 'mfa.reset'].sort(),
    );
    expect(entries.every((entry) => String(entry.actorId) === admin.id)).toBe(true);
  });

  it("can't be used on your own account, or by support staff", async () => {
    const admin = await createStaff('aroha@example.co.nz', 'ADMIN');
    await createStaff('sam@example.co.nz', 'SUPPORT');

    const self = await (await staffAgent()).post(`/api/v1/admin/staff/${admin.id}/mfa/reset`);
    expect(self.status).toBe(403);

    const bySupport = await (
      await staffAgent('sam@example.co.nz')
    ).post(`/api/v1/admin/staff/${admin.id}/mfa/reset`);
    expect(bySupport.status).toBe(403);
    expect((await UserModel.findById(admin._id))?.mfa?.enabledAt).toBeInstanceOf(Date);
  });
});
