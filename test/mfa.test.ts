import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { decrypt, encrypt } from '../src/lib/encryption.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { MAX_MFA_ATTEMPTS } from '../src/modules/auth/auth.service.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import {
  PASSWORD,
  STAFF_TOTP_SECRET,
  browserAgent,
  createStaff,
  createUser,
  staffAgent,
  staffCode,
} from './helpers.js';

/** The secret of a second authenticator app, added by addBackupDevice(). */
const BACKUP_SECRET = 'KRUGS4ZANFZSAYJAORSXG5BAONSWG4TF';

async function passwordStep(email = 'aroha@example.co.nz') {
  const agent = browserAgent();
  const response = await agent
    .post('/api/v1/auth/login')
    .send({ email, password: PASSWORD, portal: 'admin' });
  return { agent, response };
}

/** Signs in with the password alone, for staff without two-factor sign-in. */
async function passwordOnlyAgent(email = 'aroha@example.co.nz') {
  const { agent, response } = await passwordStep(email);
  expect(response.body.user.email).toBe(email);
  return agent;
}

async function addBackupDevice(email = 'aroha@example.co.nz') {
  await UserModel.updateOne(
    { email },
    {
      $push: {
        'mfa.devices': { name: 'Backup phone', secret: encrypt(BACKUP_SECRET), addedAt: new Date() },
      },
    },
  );
}

const mfaEmails = (change: string) =>
  JobModel.countDocuments({ 'payload.template': 'mfaChanged', 'payload.props.change': change });

describe('turning on two-factor sign-in', () => {
  it('shows a QR code, then turns it on with the first code and signs out other devices', async () => {
    const staff = await createUser({ email: 'aroha@example.co.nz', roles: ['ADMIN'] });
    const other = await passwordOnlyAgent();
    const agent = await passwordOnlyAgent();
    expect(await SessionModel.countDocuments({ userId: staff._id })).toBe(2);
    expect((await agent.get('/api/v1/me/mfa')).body).toEqual({ enabled: false, maxDevices: 2, devices: [] });

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
      .send({ code: await generate({ secret: setup.body.secret }), name: 'Work phone' });
    expect(enabled.status).toBe(200);
    expect(enabled.body.user.mfaEnabled).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'mfa.enabled', entityId: staff.id })).toBe(1);
    expect(await mfaEmails('ENABLED')).toBe(1);

    // The other browser only had the password, so it's signed out; this one stays.
    expect(await SessionModel.countDocuments({ userId: staff._id })).toBe(1);
    expect((await other.post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await agent.get('/api/v1/admin/overview')).status).toBe(200);

    const status = await agent.get('/api/v1/me/mfa');
    expect(status.body).toEqual({
      enabled: true,
      maxDevices: 2,
      devices: [{ id: expect.any(String), name: 'Work phone', addedAt: expect.any(String) }],
    });
    expect(JSON.stringify(status.body)).not.toContain(setup.body.secret);

    // The next sign-in asks for a code.
    expect((await passwordStep()).response.body.mfaRequired).toBe(true);
  });

  it('is for staff only', async () => {
    await createUser();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    expect((await agent.post('/api/v1/me/mfa/setup')).status).toBe(403);
    expect((await agent.get('/api/v1/me/mfa')).status).toBe(403);
  });
});

describe('a second authenticator app', () => {
  it('needs a code from the current app, then either app signs in', async () => {
    const staff = await createStaff();
    const agent = await staffAgent();

    const setup = await agent.post('/api/v1/me/mfa/setup');
    const newCode = await generate({ secret: setup.body.secret });

    const missing = await agent.post('/api/v1/me/mfa/verify').send({ code: newCode });
    expect(missing.body.error.fields).toHaveProperty('currentCode');
    const wrong = await agent.post('/api/v1/me/mfa/verify').send({ code: newCode, currentCode: '000000' });
    expect(wrong.body.error.code).toBe('CODE_INVALID');
    expect(wrong.body.error.fields).toHaveProperty('currentCode');

    const added = await agent
      .post('/api/v1/me/mfa/verify')
      .send({ code: newCode, currentCode: await staffCode() });
    expect(added.status).toBe(200);
    expect(await AuditLogModel.countDocuments({ action: 'mfa.device.added', entityId: staff.id })).toBe(1);
    expect(await mfaEmails('DEVICE_ADDED')).toBe(1);
    // Adding a backup doesn't sign anyone out.
    expect(await SessionModel.countDocuments({ userId: staff._id })).toBe(1);

    const { devices } = (await agent.get('/api/v1/me/mfa')).body;
    expect(devices.map((device: { name: string }) => device.name)).toEqual(['Phone', 'Backup authenticator']);

    // Two is the most.
    const third = await agent.post('/api/v1/me/mfa/setup');
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('MFA_DEVICE_LIMIT');

    // The new app's codes sign in too.
    const { agent: next, response } = await passwordStep();
    const done = await next
      .post('/api/v1/auth/login/mfa')
      .send({ challenge: response.body.challenge, code: await staffCode(undefined, setup.body.secret) });
    expect(done.status).toBe(200);
  });

  it('can be removed with a code from either app, but the last app stays', async () => {
    const staff = await createStaff();
    await addBackupDevice();
    const agent = await staffAgent();
    const [phone, backup] = (await agent.get('/api/v1/me/mfa')).body.devices;

    const wrong = await agent.post(`/api/v1/me/mfa/devices/${phone.id}/remove`).send({ code: '000000' });
    expect(wrong.body.error.code).toBe('CODE_INVALID');

    // A lost phone is removed with a code from the backup.
    const removed = await agent
      .post(`/api/v1/me/mfa/devices/${phone.id}/remove`)
      .send({ code: await staffCode(undefined, BACKUP_SECRET) });
    expect(removed.status).toBe(200);
    expect(removed.body.devices).toEqual([expect.objectContaining({ id: backup.id, name: 'Backup phone' })]);
    expect(removed.body.devices[0].lastUsedAt).toEqual(expect.any(String));
    expect(await AuditLogModel.countDocuments({ action: 'mfa.device.removed', entityId: staff.id })).toBe(1);
    expect(await mfaEmails('DEVICE_REMOVED')).toBe(1);

    const again = await agent
      .post(`/api/v1/me/mfa/devices/${phone.id}/remove`)
      .send({ code: await staffCode(undefined, BACKUP_SECRET) });
    expect(again.status).toBe(404);

    const last = await agent
      .post(`/api/v1/me/mfa/devices/${backup.id}/remove`)
      .send({ code: await staffCode(undefined, BACKUP_SECRET) });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('MFA_LAST_DEVICE');
  });
});

describe('turning off two-factor sign-in', () => {
  it('needs a code, then sign-in needs only the password', async () => {
    const staff = await createStaff();
    await addBackupDevice();
    const agent = await staffAgent();

    const wrong = await agent.post('/api/v1/me/mfa/disable').send({ code: '000000' });
    expect(wrong.body.error.code).toBe('CODE_INVALID');
    const missing = await agent.post('/api/v1/me/mfa/disable').send({});
    expect(missing.body.error.fields).toHaveProperty('code');
    expect((await UserModel.findById(staff._id))?.mfa?.enabledAt).toBeInstanceOf(Date);

    const disabled = await agent
      .post('/api/v1/me/mfa/disable')
      .send({ code: await staffCode(undefined, BACKUP_SECRET) });
    expect(disabled.status).toBe(200);
    expect(disabled.body.user.mfaEnabled).toBe(false);
    expect((await UserModel.findById(staff._id))?.mfa).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'mfa.disabled', entityId: staff.id })).toBe(1);
    expect(await mfaEmails('DISABLED')).toBe(1);
    expect((await agent.get('/api/v1/me/mfa')).body).toEqual({ enabled: false, maxDevices: 2, devices: [] });

    await passwordOnlyAgent();

    const twice = await agent.post('/api/v1/me/mfa/disable').send({ code: '123456' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('MFA_NOT_ENABLED');
  });

  it('can be turned on again with a new app', async () => {
    await createStaff();
    const agent = await staffAgent();
    await agent.post('/api/v1/me/mfa/disable').send({ code: await staffCode() });

    const setup = await agent.post('/api/v1/me/mfa/setup');
    const enabled = await agent
      .post('/api/v1/me/mfa/verify')
      .send({ code: await generate({ secret: setup.body.secret }) });
    expect(enabled.body.user.mfaEnabled).toBe(true);
    expect((await agent.get('/api/v1/me/mfa')).body.devices).toHaveLength(1);
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

  it('turns an app set up before backups existed into the first device, keeping its used codes', async () => {
    const staff = await createUser({ email: 'aroha@example.co.nz', roles: ['ADMIN'] });
    const now = Math.floor(Date.now() / 30_000);
    await UserModel.collection.updateOne(
      { _id: staff._id },
      { $set: { mfa: { secret: encrypt(STAFF_TOTP_SECRET), enabledAt: new Date(), lastTimeStep: now } } },
    );

    const { agent, response } = await passwordStep();
    const { challenge } = response.body;
    const used = await generate({ secret: STAFF_TOTP_SECRET, epoch: now * 30 });
    const replay = await agent.post('/api/v1/auth/login/mfa').send({ challenge, code: used });
    expect(replay.body.error.code).toBe('CODE_INVALID');

    const next = await generate({ secret: STAFF_TOTP_SECRET, epoch: (now + 1) * 30 });
    expect((await agent.post('/api/v1/auth/login/mfa').send({ challenge, code: next })).status).toBe(200);

    const saved = await UserModel.collection.findOne({ _id: staff._id });
    expect(saved?.mfa).not.toHaveProperty('secret');
    expect(saved?.mfa.devices).toEqual([
      expect.objectContaining({ name: 'Authenticator app', lastTimeStep: now + 1 }),
    ]);
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
