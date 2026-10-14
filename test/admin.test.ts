import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

async function signedInAs(email: string) {
  const agent = browserAgent();
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return agent;
}

describe('GET /api/v1/admin/dashboard', () => {
  it('needs a signed-in user', async () => {
    const response = await request(testApp()).get('/api/v1/admin/dashboard');
    expect(response.status).toBe(401);
  });

  it('is forbidden for guests and hosts', async () => {
    await createUser({ roles: ['GUEST', 'HOST'] });
    const agent = await signedInAs('kiri@example.co.nz');

    const response = await agent.get('/api/v1/admin/dashboard');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it("opens to staff who haven't turned on two-factor sign-in, but not once they're suspended", async () => {
    const staff = await createUser({ email: 'aroha@example.co.nz', roles: ['SUPPORT'] });
    const agent = await signedInAs('aroha@example.co.nz');
    expect((await agent.get('/api/v1/admin/dashboard')).status).toBe(200);

    await UserModel.updateOne({ _id: staff._id }, { $set: { status: 'SUSPENDED' } });
    expect((await agent.get('/api/v1/admin/dashboard')).status).toBe(401);
  });

  it('returns real user counts to staff; the old overview, with its blank figures, is gone', async () => {
    await createStaff('aroha@example.co.nz', 'ADMIN');
    await createStaff('sam@example.co.nz', 'SUPPORT');
    await createUser({ email: 'hana@example.co.nz', roles: ['GUEST', 'HOST'] });
    await createUser({ email: 'kiri@example.co.nz', roles: ['GUEST'] });
    await createUser({ email: 'tama@example.co.nz', roles: ['GUEST'], status: 'SUSPENDED' });

    for (const email of ['aroha@example.co.nz', 'sam@example.co.nz']) {
      const agent = await staffAgent(email);
      const response = await agent.get('/api/v1/admin/dashboard');
      expect(response.status).toBe(200);
      expect(response.body.figures).toMatchObject({ totalUsers: 3, suspendedUsers: 1 });
      expect((await agent.get('/api/v1/admin/overview')).status).toBe(404);
    }
  });
});

describe('the staff overview’s counts', () => {
  it('count only cars with a current rego and WOF or CoF, and held and failed payouts apart', async () => {
    const host = await createHost();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await createVehicle(host._id);
    await createVehicle(host._id, { wofExpiry: past, cofExpiry: new Date(Date.now() + 1e10) });
    await createVehicle(host._id, { wofExpiry: past });
    await createVehicle(host._id, { regoExpiry: past });
    const guest = await createUser({ email: 'kiri@example.co.nz' });
    const vehicle = await createVehicle(host._id);
    const booking = await createBookingRecord({
      guestId: guest._id,
      hostId: host._id,
      vehicleId: vehicle._id,
    });
    const payout = { hostId: host._id, bookingId: booking._id, amountCents: 1_000, scheduledFor: new Date() };
    await PayoutModel.create([
      { ...payout, type: 'TRIP', status: 'HELD', holdReason: 'INCIDENT' },
      { ...payout, type: 'CANCELLATION_FEE', status: 'FAILED' },
      { ...payout, type: 'EXTRA_CHARGE', extraChargeId: new mongoose.Types.ObjectId(), status: 'FAILED' },
    ]);
    await createStaff();

    const dashboard = (await (await staffAgent()).get('/api/v1/admin/dashboard')).body;
    expect(dashboard.figures.activeVehicles).toBe(3);
    expect(dashboard.queues).toMatchObject({ heldPayouts: 1, failedPayouts: 2 });
  });
});

describe('the session’s staff permissions', () => {
  it('show what each staff member may do, and nothing for Guests and Hosts', async () => {
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    await createStaff('mere@example.co.nz', 'SUPPORT');
    await UserModel.updateOne({ _id: sam._id }, { $set: { permissions: ['REFUNDS'] } });
    await createUser({ email: 'kiri@example.co.nz', roles: ['GUEST', 'HOST'] });

    const session = async (agent: ReturnType<typeof browserAgent>) =>
      (await agent.post('/api/v1/auth/session')).body.user;
    expect((await session(await staffAgent('aroha@example.co.nz'))).permissions).toEqual(['REFUNDS']);
    expect((await session(await staffAgent('sam@example.co.nz'))).permissions).toEqual(['REFUNDS']);
    expect((await session(await staffAgent('mere@example.co.nz'))).permissions).toEqual([]);
    expect(await session(await signedInAs('kiri@example.co.nz'))).not.toHaveProperty('permissions');
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
