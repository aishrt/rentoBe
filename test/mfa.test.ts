import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/lib/encryption.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { MAX_MFA_ATTEMPTS } from '../src/modules/auth/auth.service.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffCode } from './helpers.js';

async function passwordStep(email = 'aroha@example.co.nz') {
  const agent = browserAgent();
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD, portal: 'admin' });
  return { agent, response };
}

describe('setting up the authenticator app', () => {
  it('shows a QR code, then turns two-factor sign-in on with the first code', async () => {
    const staff = await createUser({ email: 'aroha@example.co.nz', roles: ['ADMIN'] });
    const { agent } = await passwordStep();

    const setup = await agent.post('/api/v1/me/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.otpauthUrl).toContain('issuer=Rento%20Vroom');
    // Only the encrypted secret is saved.
    const saved = await UserModel.findById(staff._id).select('+mfa.pendingSecret');
    expect(saved?.mfa?.pendingSecret).not.toContain(setup.body.secret);
    expect(decrypt(saved!.mfa!.pendingSecret!)).toBe(setup.body.secret);

    const wrong = await agent.post('/api/v1/me/mfa/verify').send({ code: '000000' });
    expect(wrong.body.error.code).toBe('CODE_INVALID');

    const enabled = await agent
      .post('/api/v1/me/mfa/verify')
      .send({ code: await generate({ secret: setup.body.secret }) });
    expect(enabled.status).toBe(200);
    expect(enabled.body.user.mfaEnabled).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'mfa.enabled', entityId: staff.id })).toBe(1);

    // The staff portal is open now.
    expect((await agent.get('/api/v1/admin/overview')).status).toBe(200);
  });

  it('is for staff only', async () => {
    await createUser();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    expect((await agent.post('/api/v1/me/mfa/setup')).status).toBe(403);
  });
});

describe('staff sign-in with the authenticator app', () => {
  it('asks for the code after the password, and signs in only with it', async () => {
    await createStaff();
    const { agent, response } = await passwordStep();

    expect(response.body).toEqual({ mfaRequired: true, challenge: expect.any(String) });
    // No session yet.
    expect((await agent.get('/api/v1/me')).status).toBe(401);

    const done = await agent
      .post('/api/v1/auth/login/mfa')
      .send({ challenge: response.body.challenge, code: await staffCode() });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ email: 'aroha@example.co.nz', mfaEnabled: true });
    expect((await agent.get('/api/v1/admin/overview')).status).toBe(200);
  });

  it('accepts each code once', async () => {
    await createStaff();
    const code = await staffCode();

    const first = await passwordStep();
    await first.agent.post('/api/v1/auth/login/mfa').send({ challenge: first.response.body.challenge, code });

    const second = await passwordStep();
    const replay = await second.agent
      .post('/api/v1/auth/login/mfa')
      .send({ challenge: second.response.body.challenge, code });
    expect(replay.body.error.code).toBe('CODE_INVALID');
  });

  it(`ends the attempt after ${MAX_MFA_ATTEMPTS} wrong codes`, async () => {
    await createStaff();
    const { agent, response } = await passwordStep();
    const { challenge } = response.body;

    for (let attempt = 1; attempt < MAX_MFA_ATTEMPTS; attempt++) {
      const wrong = await agent.post('/api/v1/auth/login/mfa').send({ challenge, code: '000000' });
      expect(wrong.body.error.code).toBe('CODE_INVALID');
    }
    const last = await agent.post('/api/v1/auth/login/mfa').send({ challenge, code: '000000' });
    expect(last.status).toBe(401);
    expect(last.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');

    // Even the right code no longer works with that challenge.
    const tooLate = await agent.post('/api/v1/auth/login/mfa').send({ challenge, code: await staffCode() });
    expect(tooLate.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it("doesn't ask guests for a code", async () => {
    await createUser();
    const agent = browserAgent();
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'kiri@example.co.nz', password: PASSWORD });
    expect(response.body.user.email).toBe('kiri@example.co.nz');
  });
});

describe('encryption', () => {
  it('encrypts differently each time, and refuses a changed value', () => {
    const first = encrypt('JBSWY3DPEHPK3PXP');
    expect(first).not.toBe(encrypt('JBSWY3DPEHPK3PXP'));
    expect(decrypt(first)).toBe('JBSWY3DPEHPK3PXP');

    const [version, iv, tag, ciphertext] = first.split(':');
    const tampered = [version, iv, tag, `A${ciphertext!.slice(1)}`].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });
});
