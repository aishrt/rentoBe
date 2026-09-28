import { describe, expect, it } from 'vitest';
import { AGREEMENT_VERSIONS } from '../src/modules/users/agreements.js';
import { UserModel, type AgreementType } from '../src/modules/users/user.model.js';
import { PASSWORD, browserAgent, createStaff, createUser } from './helpers.js';

const OLD_VERSION = '2020-01-01';

async function withAgreements(types: AgreementType[], version?: string) {
  const user = await createUser();
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        agreements: types.map((type) => ({
          type,
          version: version ?? AGREEMENT_VERSIONS[type],
          acceptedAt: new Date('2026-01-01'),
        })),
      },
    },
  );
  return user;
}

async function signIn(email = 'kiri@example.co.nz') {
  const agent = browserAgent();
  const login = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { agent, user: login.body.user };
}

describe('accepting new versions of legal documents (plan §6.1)', () => {
  it('asks for nothing when the current Terms and Privacy Policy are accepted', async () => {
    await withAgreements(['TERMS', 'PRIVACY']);
    const { user } = await signIn();
    expect(user.pendingAgreements).toEqual([]);
  });

  it('asks again for documents with a newer version, including agreements accepted before', async () => {
    await withAgreements(['TERMS', 'PRIVACY', 'GUEST'], OLD_VERSION);
    const { user } = await signIn();
    expect(user.pendingAgreements).toEqual(['TERMS', 'PRIVACY', 'GUEST']);
  });

  it('never asks for the Host Agreement before the Host application does', async () => {
    await withAgreements(['TERMS', 'PRIVACY']);
    const { user } = await signIn();
    expect(user.pendingAgreements).not.toContain('HOST');
  });

  it('records the acceptance with the current version, time and IP, keeping the earlier ones', async () => {
    const created = await withAgreements(['TERMS', 'PRIVACY'], OLD_VERSION);
    const { agent } = await signIn();

    const response = await agent.post('/api/v1/me/agreements').send({ types: ['TERMS', 'PRIVACY'] });
    expect(response.status).toBe(200);
    expect(response.body.user.pendingAgreements).toEqual([]);

    const { agreements } = (await UserModel.findById(created._id))!;
    expect(agreements).toHaveLength(4);
    expect(agreements.at(-1)).toMatchObject({ type: 'PRIVACY', version: AGREEMENT_VERSIONS.PRIVACY });
    expect(agreements.at(-1)?.ip).toBeTruthy();
    expect((await agent.get('/api/v1/me')).body.user.pendingAgreements).toEqual([]);
  });

  it('refuses unknown documents and signed-out requests', async () => {
    await withAgreements([]);
    const { agent } = await signIn();
    const unknown = await agent.post('/api/v1/me/agreements').send({ types: ['COOKIES'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.fields).toHaveProperty(['types.0']);
    expect((await agent.post('/api/v1/me/agreements').send({ types: [] })).status).toBe(400);

    const signedOut = await browserAgent()
      .post('/api/v1/me/agreements')
      .send({ types: ['TERMS'] });
    expect(signedOut.status).toBe(401);
  });

  it('asks staff-only accounts for nothing', async () => {
    await createStaff();
    const user = await UserModel.findOne({ email: 'aroha@example.co.nz' });
    const { toPublicUser } = await import('../src/modules/users/user.service.js');
    expect(toPublicUser(user!).pendingAgreements).toEqual([]);
  });
});
