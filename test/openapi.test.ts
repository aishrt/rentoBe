import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { errorResponseSchema } from '../src/lib/http-error.js';
import { adminOverviewSchema } from '../src/modules/admin/admin.schemas.js';
import { ACCESS_COOKIE } from '../src/modules/auth/auth.cookies.js';
import { sessionResponseSchema } from '../src/modules/auth/auth.schemas.js';
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
});
