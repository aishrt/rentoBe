import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { errorResponseSchema } from '../src/lib/http-error.js';
import { adminOverviewSchema } from '../src/modules/admin/admin.schemas.js';
import { ACCESS_COOKIE } from '../src/modules/auth/auth.cookies.js';
import { consoleCodeFor } from '../src/integrations/sms/phone-verifier.js';
import {
  emailResponseSchema,
  mfaChallengeResponseSchema,
  mfaSetupResponseSchema,
  mfaStatusResponseSchema,
  phoneCodeResponseSchema,
  resendVerificationResponseSchema,
  sessionResponseSchema,
} from '../src/modules/auth/auth.schemas.js';
import { AuthTokenModel } from '../src/modules/auth/auth-token.model.js';
import { createAuthLink } from '../src/modules/auth/auth-links.js';
import { userResponseSchema } from '../src/modules/users/user.schemas.js';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffCode } from './helpers.js';

describe('API contract (openapi.json)', () => {
  it('is up to date with the routes and schemas; if not, run `npm run openapi` and commit it', async () => {
    const committed = JSON.parse(await readFile('openapi.json', 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('names the real access cookie', () => {
    const { components } = buildOpenApiDocument();
    expect(components?.securitySchemes?.cookieAuth).toMatchObject({ name: ACCESS_COOKIE });
  });

  it('describes what the API really returns', async () => {
    await createStaff('kiri@example.co.nz', 'SUPPORT');
    const agent = browserAgent();

    expect(sessionResponseSchema.parse((await agent.post('/api/v1/auth/session')).body)).toEqual({
      user: null,
    });

    const invalid = await agent.post('/api/v1/auth/login').send({ email: 'nope' });
    expect(errorResponseSchema.parse(invalid.body).error.fields).toHaveProperty('email');

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'kiri@example.co.nz', password: PASSWORD });
    const { challenge } = mfaChallengeResponseSchema.parse(login.body);
    const withCode = await agent
      .post('/api/v1/auth/login/mfa')
      .send({ challenge, code: await staffCode('kiri@example.co.nz') });
    userResponseSchema.parse(withCode.body);
    sessionResponseSchema.parse((await agent.post('/api/v1/auth/session')).body);
    userResponseSchema.parse((await agent.get('/api/v1/me')).body);
    adminOverviewSchema.parse((await agent.get('/api/v1/admin/overview')).body);
    userResponseSchema.parse((await agent.post('/api/v1/auth/refresh')).body);

    const loggedOut = await agent.post('/api/v1/auth/logout');
    expect(loggedOut.status).toBe(204);
    errorResponseSchema.parse((await agent.get('/api/v1/me')).body);
  });

  it('describes the sign-up and email confirmation responses', async () => {
    const agent = browserAgent();
    const signup = await agent.post('/api/v1/auth/signup').send({
      firstName: 'Hana',
      lastName: 'Walker',
      email: 'hana@example.co.nz',
      password: 'tui sing at dawn',
      acceptTerms: true,
    });
    expect(signup.status).toBe(201);
    userResponseSchema.parse(signup.body);
    resendVerificationResponseSchema.parse((await agent.post('/api/v1/auth/verify-email/resend')).body);

    const { userId } = (await AuthTokenModel.findOne({ purpose: 'VERIFY_EMAIL' }))!;
    const token = await createAuthLink(userId, 'VERIFY_EMAIL', 60_000);
    emailResponseSchema.parse((await agent.post('/api/v1/auth/verify-email').send({ token })).body);
    errorResponseSchema.parse((await agent.post('/api/v1/auth/verify-email').send({ token })).body);
  });

  it('describes the account security responses', async () => {
    await createUser();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    const { phone } = phoneCodeResponseSchema.parse(
      (await agent.post('/api/v1/auth/phone/otp').send({ phone: '021 123 4567' })).body,
    );
    const verified = await agent.post('/api/v1/auth/phone/verify').send({ code: consoleCodeFor(phone) });
    expect(userResponseSchema.parse(verified.body).user.phoneVerified).toBe(true);

    const emailChange = await agent
      .post('/api/v1/me/email')
      .send({ newEmail: 'kiri.new@example.co.nz', currentPassword: PASSWORD });
    emailResponseSchema.parse(emailChange.body);
    expect((await agent.post('/api/v1/auth/forgot-password').send({ email: 'x@example.co.nz' })).status).toBe(
      204,
    );

    await createUser({ email: 'aroha@example.co.nz', roles: ['ADMIN'] });
    const staff = browserAgent();
    await staff.post('/api/v1/auth/login').send({ email: 'aroha@example.co.nz', password: PASSWORD });
    mfaStatusResponseSchema.parse((await staff.get('/api/v1/me/mfa')).body);
    mfaSetupResponseSchema.parse((await staff.post('/api/v1/me/mfa/setup')).body);
  });
});
