import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PASSWORD, browserAgent, createUser, testApp } from './helpers.js';

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

  it('returns real user counts to staff, and null for metrics not tracked yet', async () => {
    await createUser({ email: 'aroha@example.co.nz', roles: ['ADMIN'] });
    await createUser({ email: 'sam@example.co.nz', roles: ['SUPPORT'] });
    await createUser({ email: 'hana@example.co.nz', roles: ['GUEST', 'HOST'] });
    await createUser({ email: 'kiri@example.co.nz', roles: ['GUEST'] });
    await createUser({ email: 'tama@example.co.nz', roles: ['GUEST'], status: 'SUSPENDED' });

    for (const email of ['aroha@example.co.nz', 'sam@example.co.nz']) {
      const response = await (await signedInAs(email)).get('/api/v1/admin/overview');
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
