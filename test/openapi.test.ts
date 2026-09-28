import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { errorResponseSchema } from '../src/lib/http-error.js';
import { adminOverviewSchema } from '../src/modules/admin/admin.schemas.js';
import { ACCESS_COOKIE } from '../src/modules/auth/auth.cookies.js';
import {
  resendVerificationResponseSchema,
  sessionResponseSchema,
  verifyEmailResponseSchema,
} from '../src/modules/auth/auth.schemas.js';
import { AuthTokenModel } from '../src/modules/auth/auth-token.model.js';
import { createAuthLink } from '../src/modules/auth/auth-links.js';
import { userResponseSchema } from '../src/modules/users/user.schemas.js';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { PASSWORD, browserAgent, createUser } from './helpers.js';

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
    await createUser({ roles: ['ADMIN'] });
    const agent = browserAgent();

    expect(sessionResponseSchema.parse((await agent.post('/api/v1/auth/session')).body)).toEqual({
      user: null,
    });

    const invalid = await agent.post('/api/v1/auth/login').send({ email: 'nope' });
    expect(errorResponseSchema.parse(invalid.body).error.fields).toHaveProperty('email');

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'kiri@example.co.nz', password: PASSWORD });
    userResponseSchema.parse(login.body);
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
    verifyEmailResponseSchema.parse((await agent.post('/api/v1/auth/verify-email').send({ token })).body);
    errorResponseSchema.parse((await agent.post('/api/v1/auth/verify-email').send({ token })).body);
  });
});
