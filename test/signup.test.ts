import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { JobModel } from '../src/jobs/job.model.js';
import { AuthTokenModel } from '../src/modules/auth/auth-token.model.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { AGREEMENT_VERSIONS } from '../src/modules/users/agreements.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { FRONTEND_ORIGIN, browserAgent, createUser, setCookieHeaders, testApp } from './helpers.js';

const newAccount = {
  firstName: 'Hana',
  lastName: 'Walker',
  email: 'Hana.Walker@Example.co.nz',
  password: 'tui sing at dawn',
  acceptTerms: true,
};

const signup = (body: object = newAccount) =>
  request(testApp()).post('/api/v1/auth/signup').set('Origin', FRONTEND_ORIGIN).send(body);

/** The link in the newest queued email with this template. */
async function emailedLink(template: string): Promise<string> {
  const job = await JobModel.findOne({ type: 'email.send', 'payload.template': template }).sort({
    createdAt: -1,
  });
  const url = (job?.payload as { props?: { verifyUrl?: string } } | undefined)?.props?.verifyUrl;
  if (!url) throw new Error(`No ${template} email was queued`);
  return url;
}

const tokenFrom = (url: string) => new URL(url).searchParams.get('token')!;

describe('POST /api/v1/auth/signup', () => {
  it('creates a Guest account, signs it in and records the agreements', async () => {
    const response = await signup();

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({
      email: 'hana.walker@example.co.nz',
      firstName: 'Hana',
      roles: ['GUEST'],
      emailVerified: false,
    });
    expect(setCookieHeaders(response).some((cookie) => cookie.startsWith('rv_access='))).toBe(true);
    expect(await SessionModel.countDocuments()).toBe(1);

    const user = await UserModel.findOne({ email: 'hana.walker@example.co.nz' }).select('+passwordHash');
    expect(user?.passwordHash).not.toContain('tui');
    expect(user?.agreements.map(({ type, version }) => ({ type, version }))).toEqual([
      { type: 'TERMS', version: AGREEMENT_VERSIONS.TERMS },
      { type: 'PRIVACY', version: AGREEMENT_VERSIONS.PRIVACY },
    ]);
    expect(user?.agreements[0]?.ip).toBeTruthy();
  });

  it('emails a link to confirm the address, storing only its hash', async () => {
    await signup();

    const link = await emailedLink('verifyEmail');
    expect(link).toMatch(/^http:\/\/localhost:5173\/verify-email\?token=/);
    const stored = await AuthTokenModel.findOne({ purpose: 'VERIFY_EMAIL' });
    expect(stored?.tokenHash).toBeDefined();
    expect(stored?.tokenHash).not.toBe(tokenFrom(link));
  });

  it('refuses an email address that already has an account, whatever its capitals', async () => {
    await createUser({ email: 'hana.walker@example.co.nz' });
    const response = await signup();

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EMAIL_TAKEN');
    expect(response.body.error.fields).toHaveProperty('email');
  });

  it('checks every field, with a message for each', async () => {
    const response = await signup({ firstName: ' ', email: 'nope', password: 'short', acceptTerms: false });

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.fields).sort()).toEqual(
      ['acceptTerms', 'email', 'firstName', 'lastName', 'password'].sort(),
    );
  });

  it('refuses common passwords and ones built from the email address', async () => {
    const common = await signup({ ...newAccount, password: 'Password123' });
    expect(common.body.error.fields.password).toMatch(/too common/);

    const ownEmail = await signup({ ...newAccount, password: 'hana.walker2026!' });
    expect(ownEmail.body.error.fields.password).toMatch(/email address/);
  });
});

describe('confirming the email address', () => {
  it('confirms from the link, even signed out, and then sends the welcome email', async () => {
    await signup();
    const token = tokenFrom(await emailedLink('verifyEmail'));

    const response = await request(testApp())
      .post('/api/v1/auth/verify-email')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ token });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ email: 'hana.walker@example.co.nz' });
    const user = await UserModel.findOne({ email: 'hana.walker@example.co.nz' });
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await JobModel.countDocuments({ 'payload.template': 'welcome' })).toBe(1);
  });

  it('accepts each link once', async () => {
    await signup();
    const token = tokenFrom(await emailedLink('verifyEmail'));
    const verify = () =>
      request(testApp()).post('/api/v1/auth/verify-email').set('Origin', FRONTEND_ORIGIN).send({ token });

    expect((await verify()).status).toBe(200);
    const again = await verify();
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('LINK_INVALID');
  });

  it('refuses an expired link', async () => {
    await signup();
    const token = tokenFrom(await emailedLink('verifyEmail'));
    await AuthTokenModel.updateMany({}, { expiresAt: new Date(Date.now() - 1_000) });

    const response = await request(testApp())
      .post('/api/v1/auth/verify-email')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ token });
    expect(response.body.error.code).toBe('LINK_INVALID');
  });

  it('sends a new link on request, and the old one stops working', async () => {
    const agent = browserAgent();
    await agent.post('/api/v1/auth/signup').send(newAccount);
    const oldToken = tokenFrom(await emailedLink('verifyEmail'));

    const resent = await agent.post('/api/v1/auth/verify-email/resend');
    expect(resent.body).toEqual({ sent: true });
    const newToken = tokenFrom(await emailedLink('verifyEmail'));
    expect(newToken).not.toBe(oldToken);

    expect((await agent.post('/api/v1/auth/verify-email').send({ token: oldToken })).status).toBe(400);
    expect((await agent.post('/api/v1/auth/verify-email').send({ token: newToken })).status).toBe(200);
    // Nothing more to send once it's confirmed.
    expect((await agent.post('/api/v1/auth/verify-email/resend')).body).toEqual({ sent: false });
  });

  it('only resends for a signed-in user', async () => {
    const response = await request(testApp())
      .post('/api/v1/auth/verify-email/resend')
      .set('Origin', FRONTEND_ORIGIN);
    expect(response.status).toBe(401);
  });

  it('limits how many emails a user can ask for', async () => {
    const agent = request.agent(createApp({ rateLimit: true })).set('Origin', FRONTEND_ORIGIN);
    await agent.post('/api/v1/auth/signup').send(newAccount);

    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await agent.post('/api/v1/auth/verify-email/resend')).status).toBe(200);
    }
    const blocked = await agent.post('/api/v1/auth/verify-email/resend');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
