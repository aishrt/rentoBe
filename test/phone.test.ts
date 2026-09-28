import { describe, expect, it, vi } from 'vitest';
import {
  PhoneVerifierError,
  consoleCodeFor,
  createTwilioVerifier,
} from '../src/integrations/sms/phone-verifier.js';
import { toMobileE164 } from '../src/lib/phone.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { PASSWORD, browserAgent, createUser } from './helpers.js';

async function signIn(email = 'kiri@example.co.nz') {
  const agent = browserAgent();
  await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return agent;
}

describe('mobile numbers', () => {
  it('reads NZ numbers without +64 and overseas numbers with their code, in E.164', () => {
    expect(toMobileE164('021 123 4567')).toBe('+64211234567');
    expect(toMobileE164('+64 21 123 4567')).toBe('+64211234567');
    expect(toMobileE164('+61 412 345 678')).toBe('+61412345678');
  });

  it("refuses numbers that can't receive texts", () => {
    expect(toMobileE164('09 309 0000')).toBeNull(); // Auckland landline
    expect(toMobileE164('12345')).toBeNull();
    expect(toMobileE164('not a number')).toBeNull();
  });
});

describe('phone verification', () => {
  it('texts a code, then verifies the number with it', async () => {
    const user = await createUser();
    const agent = await signIn();

    const sent = await agent.post('/api/v1/auth/phone/otp').send({ phone: '021 123 4567' });
    expect(sent.body).toEqual({ phone: '+64211234567', sent: true });

    const code = consoleCodeFor('+64211234567')!;
    const verified = await agent
      .post('/api/v1/auth/phone/verify')
      .send({ code: `${code.slice(0, 3)} ${code.slice(3)}` });

    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ phone: '+64211234567', phoneVerified: true });
    const saved = await UserModel.findById(user._id);
    expect(saved?.pendingPhone).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'phone.verified', entityId: user.id })).toBe(1);
  });

  it('keeps the old number until a new one is verified', async () => {
    const user = await createUser();
    await UserModel.updateOne({ _id: user._id }, { phone: '+64211234567', phoneVerifiedAt: new Date() });
    const agent = await signIn();

    await agent.post('/api/v1/auth/phone/otp').send({ phone: '022 765 4321' });
    expect((await agent.get('/api/v1/me')).body.user.phone).toBe('+64211234567');

    const wrong = await agent.post('/api/v1/auth/phone/verify').send({ code: '000000' });
    expect(wrong.body.error.code).toBe('CODE_INVALID');
    expect((await agent.get('/api/v1/me')).body.user.phone).toBe('+64211234567');
  });

  it("doesn't send a code for the number that's already verified", async () => {
    const user = await createUser();
    await UserModel.updateOne({ _id: user._id }, { phone: '+64211234567', phoneVerifiedAt: new Date() });

    const response = await (await signIn()).post('/api/v1/auth/phone/otp').send({ phone: '0211234567' });
    expect(response.body).toEqual({ phone: '+64211234567', sent: false });
  });

  it('refuses a number verified on another account', async () => {
    const other = await createUser({ email: 'hana@example.co.nz' });
    await UserModel.updateOne({ _id: other._id }, { phone: '+64211234567', phoneVerifiedAt: new Date() });
    await createUser();

    const response = await (await signIn()).post('/api/v1/auth/phone/otp').send({ phone: '021 123 4567' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PHONE_TAKEN');
  });

  it('explains a number it can’t use, and a code sent too early', async () => {
    await createUser();
    const agent = await signIn();

    const landline = await agent.post('/api/v1/auth/phone/otp').send({ phone: '09 309 0000' });
    expect(landline.body.error.fields.phone).toMatch(/mobile number/);

    const noCode = await agent.post('/api/v1/auth/phone/verify').send({ code: '123456' });
    expect(noCode.body.error.code).toBe('NO_CODE_SENT');
  });
});

describe('Twilio Verify', () => {
  const config = {
    accountSid: `AC${'a'.repeat(32)}`,
    authToken: 'b'.repeat(32),
    serviceSid: `VA${'c'.repeat(32)}`,
  };

  it('asks Twilio to text the code, and checks it with Twilio', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'approved' }), { status: 200 }));
    const verifier = createTwilioVerifier({ ...config, fetch });

    await verifier.sendCode('+64211234567');
    expect(await verifier.checkCode('+64211234567', '123456')).toBe(true);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://verify.twilio.com/v2/Services/${config.serviceSid}/Verifications`);
    expect(String(init.body)).toBe('To=%2B64211234567&Channel=sms&Locale=en');
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it("explains Twilio's refusals", async () => {
    const refuse = (code: number, status = 400) =>
      createTwilioVerifier({
        ...config,
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ code }), { status })),
      });

    await expect(refuse(21608).sendCode('+64211234567')).rejects.toMatchObject({
      code: 'NUMBER_NOT_ALLOWED',
    });
    await expect(refuse(60203, 429).sendCode('+64211234567')).rejects.toMatchObject({
      code: 'TOO_MANY_CODES',
    });
    await expect(refuse(60200).sendCode('+64211234567')).rejects.toBeInstanceOf(PhoneVerifierError);
  });

  it('treats an expired or unknown code as wrong', async () => {
    const verifier = createTwilioVerifier({
      ...config,
      fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 404 })),
    });
    expect(await verifier.checkCode('+64211234567', '123456')).toBe(false);
  });
});
