import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireAuth, requirePermission } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { signAccessToken } from '../src/modules/auth/auth.tokens.js';
import { UserModel, type Role } from '../src/modules/users/user.model.js';
import { createUser } from './helpers.js';

// A stand-in for the admin refund route (plan §6.2: refunds only with the REFUNDS permission).
const app = express()
  .post('/refunds', requireAuth, requirePermission('REFUNDS'), (_req, res) => {
    res.json({ refunded: true });
  })
  .use(errorHandler);

async function tokenFor(roles: Role[], permissions: string[] = []) {
  const user = await createUser({ email: `${roles.join('-').toLowerCase()}@example.co.nz`, roles });
  await UserModel.updateOne({ _id: user._id }, { $set: { permissions } });
  return { user, token: signAccessToken({ userId: user.id, roles, sessionId: 'session' }) };
}

const refund = (token?: string) => {
  const call = request(app).post('/refunds');
  return token ? call.set('Authorization', `Bearer ${token}`) : call;
};

describe('requirePermission', () => {
  it('lets admins through without the permission on their account', async () => {
    const { token } = await tokenFor(['ADMIN']);
    expect((await refund(token)).status).toBe(200);
  });

  it('refuses support staff without it, and lets them through once they have it', async () => {
    const without = await tokenFor(['SUPPORT']);
    const response = await refund(without.token);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');

    await UserModel.updateOne({ _id: without.user._id }, { $set: { permissions: ['REFUNDS'] } });
    expect((await refund(without.token)).status).toBe(200);
  });

  it('applies a removed permission at once, even with the same access token', async () => {
    const { user, token } = await tokenFor(['SUPPORT'], ['REFUNDS']);
    expect((await refund(token)).status).toBe(200);

    await UserModel.updateOne({ _id: user._id }, { $set: { permissions: [] } });
    expect((await refund(token)).status).toBe(403);
  });

  it('refuses suspended accounts and requests without a token', async () => {
    const { user, token } = await tokenFor(['ADMIN']);
    await UserModel.updateOne({ _id: user._id }, { $set: { status: 'SUSPENDED' } });
    expect((await refund(token)).status).toBe(401);
    expect((await refund()).status).toBe(401);
  });

  it('only stores permissions it knows', async () => {
    const user = await createUser();
    user.set('permissions', ['EVERYTHING']);
    await expect(user.save()).rejects.toThrow(/permissions/);
  });
});
