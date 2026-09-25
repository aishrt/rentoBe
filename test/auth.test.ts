import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MAX_FAILED_LOGINS } from '../src/modules/auth/auth.service.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { FRONTEND_ORIGIN, PASSWORD, browserAgent, createUser, setCookieHeaders, testApp } from './helpers.js';

const login = (body: object) =>
  request(testApp()).post('/api/v1/auth/login').set('Origin', FRONTEND_ORIGIN).send(body);

describe('POST /api/v1/auth/login', () => {
  it('signs in and sets httpOnly auth cookies without exposing secrets', async () => {
    await createUser();

    const response = await login({ email: '  KIRI@example.co.nz ', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      email: 'kiri@example.co.nz',
      firstName: 'Kiri',
      roles: ['GUEST'],
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');

    const cookies = setCookieHeaders(response);
    expect(cookies.find((c) => c.startsWith('rv_access='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('rv_refresh='))).toMatch(/Path=\/api\/v1\/auth/);
    expect(await SessionModel.countDocuments()).toBe(1);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await createUser();

    const wrongPassword = await login({ email: 'kiri@example.co.nz', password: 'nope' });
    const unknownEmail = await login({ email: 'nobody@example.co.nz', password: PASSWORD });

    for (const response of [wrongPassword, unknownEmail]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('returns a message for each invalid field', async () => {
    const response = await login({ email: 'not-an-email', password: '' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(response.body.error.fields)).toEqual(['email', 'password']);
  });

  it('rejects operator injection in the email field', async () => {
    await createUser();
    const response = await login({ email: { $ne: null }, password: PASSWORD });
    expect(response.status).toBe(400);
  });

  it(`locks sign-in after ${MAX_FAILED_LOGINS} wrong passwords, even with the right one`, async () => {
    await createUser();

    for (let attempt = 1; attempt < MAX_FAILED_LOGINS; attempt++) {
      expect((await login({ email: 'kiri@example.co.nz', password: 'wrong' })).status).toBe(401);
    }
    const lockingAttempt = await login({ email: 'kiri@example.co.nz', password: 'wrong' });
    expect(lockingAttempt.status).toBe(423);
    expect(lockingAttempt.body.error.code).toBe('ACCOUNT_LOCKED');

    const rightPassword = await login({ email: 'kiri@example.co.nz', password: PASSWORD });
    expect(rightPassword.status).toBe(423);
  });

  it('refuses suspended accounts', async () => {
    await createUser({ status: 'SUSPENDED' });
    const response = await login({ email: 'kiri@example.co.nz', password: PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('only lets staff sign in to the admin portal', async () => {
    await createUser();
    await createUser({ email: 'aroha@example.co.nz', roles: ['ADMIN'] });

    const guest = await login({ email: 'kiri@example.co.nz', password: PASSWORD, portal: 'admin' });
    expect(guest.status).toBe(403);
    expect(guest.body.error.code).toBe('NOT_STAFF');
    expect(setCookieHeaders(guest)).toHaveLength(0);

    const admin = await login({ email: 'aroha@example.co.nz', password: PASSWORD, portal: 'admin' });
    expect(admin.status).toBe(200);
    expect(admin.body.user.roles).toEqual(['ADMIN']);
  });

  it('rejects writes from an untrusted origin', async () => {
    await createUser();
    const response = await request(testApp())
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'kiri@example.co.nz', password: PASSWORD });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('UNTRUSTED_ORIGIN');
  });
});

describe('POST /api/v1/auth/session', () => {
  const resume = (cookie?: string) => {
    const req = request(testApp()).post('/api/v1/auth/session').set('Origin', FRONTEND_ORIGIN);
    return cookie ? req.set('Cookie', cookie) : req;
  };

  it('answers visitors who are not signed in with user: null, not an error', async () => {
    const response = await resume();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: null });
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it('returns the user from a valid access token without rotating anything', async () => {
    await createUser();
    const login = await request(testApp())
      .post('/api/v1/auth/login')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ email: 'kiri@example.co.nz', password: PASSWORD });
    const accessCookie = setCookieHeaders(login)
      .find((c) => c.startsWith('rv_access='))!
      .split(';')[0]!;

    const response = await resume(accessCookie);
    expect(response.body.user.email).toBe('kiri@example.co.nz');
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it('renews an expired access token with the refresh token', async () => {
    await createUser();
    const login = await request(testApp())
      .post('/api/v1/auth/login')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ email: 'kiri@example.co.nz', password: PASSWORD });
    const refreshCookie = setCookieHeaders(login)
      .find((c) => c.startsWith('rv_refresh='))!
      .split(';')[0]!;

    const response = await resume(`rv_access=expired-or-invalid; ${refreshCookie}`);
    expect(response.body.user.email).toBe('kiri@example.co.nz');
    const renewed = setCookieHeaders(response);
    expect(renewed.some((c) => c.startsWith('rv_access=ey'))).toBe(true);
    expect(renewed.some((c) => c.startsWith('rv_refresh=') && !c.startsWith(refreshCookie))).toBe(true);
  });

  it('clears stale cookies when the session has ended', async () => {
    const response = await resume('rv_access=stale; rv_refresh=unknown-token');
    expect(response.body).toEqual({ user: null });
    expect(setCookieHeaders(response).every((c) => c.includes('Expires=Thu, 01 Jan 1970'))).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('reads the signed-in user from /me', async () => {
    await createUser();
    const agent = browserAgent();

    expect((await agent.get('/api/v1/me')).status).toBe(401);
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('kiri@example.co.nz');
    expect(me.headers['cache-control']).toBe('private, no-store');
  });

  it('accepts the access token as a Bearer header for future mobile apps', async () => {
    await createUser();
    const response = await login({ email: 'kiri@example.co.nz', password: PASSWORD });
    const accessToken = setCookieHeaders(response)
      .find((c) => c.startsWith('rv_access='))!
      .split(';')[0]!
      .slice('rv_access='.length);

    const me = await request(testApp()).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
  });

  it('rotates the refresh token so each one works only once', async () => {
    await createUser();
    const response = await login({ email: 'kiri@example.co.nz', password: PASSWORD });
    const refreshCookie = setCookieHeaders(response)
      .find((c) => c.startsWith('rv_refresh='))!
      .split(';')[0]!;

    const refresh = () =>
      request(testApp())
        .post('/api/v1/auth/refresh')
        .set('Origin', FRONTEND_ORIGIN)
        .set('Cookie', refreshCookie);

    const first = await refresh();
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe('kiri@example.co.nz');

    const reused = await refresh();
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('ends the session on logout', async () => {
    await createUser();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    const logout = await agent.post('/api/v1/auth/logout');
    expect(logout.status).toBe(204);
    expect(await SessionModel.countDocuments()).toBe(0);
    expect((await agent.get('/api/v1/me')).status).toBe(401);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('cuts off a user who is suspended while signed in', async () => {
    const user = await createUser();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    await UserModel.updateOne({ _id: user._id }, { $set: { status: 'SUSPENDED' } });

    expect((await agent.get('/api/v1/me')).status).toBe(401);
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });
});
