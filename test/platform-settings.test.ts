import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/modules/admin/default-settings.js';
import { platformSettingsResponseSchema } from '../src/modules/admin/platform-settings.schemas.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { createHost, createVehicle, nzDay } from './fixtures.js';
import {
  FRONTEND_ORIGIN,
  PASSWORD,
  browserAgent,
  createStaff,
  createUser,
  staffAgent,
  testApp,
} from './helpers.js';

// ADMIN_EMAIL is aroha@example.co.nz in tests (vitest.config.ts), the default of createStaff().

const quote = (id: string) =>
  request(testApp())
    .post(`/api/v1/vehicles/${id}/quote`)
    .set('Origin', FRONTEND_ORIGIN)
    .send({ start: nzDay(10), end: nzDay(12), protectionPlanCode: 'STANDARD' });

describe('GET /api/v1/admin/settings', () => {
  it('gives the admin the settings in force, with every decision still pending', async () => {
    await createStaff();
    const response = await (await staffAgent()).get('/api/v1/admin/settings');

    expect(response.status).toBe(200);
    const body = platformSettingsResponseSchema.parse(response.body);
    expect(body.settings).toEqual(DEFAULT_SETTINGS);
    expect(Object.values(body.settings.decisions).every((decision) => decision.status === 'PENDING')).toBe(
      true,
    );
    expect(body.updatedBy).toBeUndefined();
  });

  it('is for the admin only', async () => {
    await createStaff();
    await createStaff('sam@example.co.nz', 'SUPPORT');
    await createUser({ roles: ['GUEST', 'HOST'] });
    const guest = browserAgent();
    await guest.post('/api/v1/auth/login').send({ email: 'kiri@example.co.nz', password: PASSWORD });

    for (const agent of [await staffAgent('sam@example.co.nz'), guest]) {
      expect((await agent.get('/api/v1/admin/settings')).status).toBe(403);
      expect((await agent.patch('/api/v1/admin/settings').send({ fees: DEFAULT_SETTINGS.fees })).status).toBe(
        403,
      );
    }
    expect((await request(testApp()).get('/api/v1/admin/settings')).status).toBe(401);
  });
});

describe('PATCH /api/v1/admin/settings', () => {
  it('applies a new service fee and protection price to the next quote, and to the public policies', async () => {
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    await createStaff();
    const admin = await staffAgent();

    const before = (await quote(vehicle.id)).body.quote.price;
    expect(before).toMatchObject({ subtotalCents: 17_800, serviceFeeCents: 1_780, protectionCents: 5_800 });

    const plans = DEFAULT_SETTINGS.protectionPlans.map((plan) =>
      plan.code === 'STANDARD' ? { ...plan, dailyPriceCents: 3_100 } : plan,
    );
    const response = await admin
      .patch('/api/v1/admin/settings')
      .send({ fees: { ...DEFAULT_SETTINGS.fees, guestServiceFeePct: 12 }, protectionPlans: plans });
    expect(response.status).toBe(200);
    expect(response.body.settings.fees.guestServiceFeePct).toBe(12);
    expect(response.body.updatedBy).toBe('Aroha Tester');

    const after = (await quote(vehicle.id)).body.quote.price;
    expect(after).toMatchObject({ subtotalCents: 17_800, serviceFeeCents: 2_136, protectionCents: 6_200 });

    const policies = await request(testApp()).get('/api/v1/policies');
    expect(policies.body.fees.guestServiceFeePct).toBe(12);
  });

  it('changes only the decisions sent, and records the change in the audit log', async () => {
    const admin = await createStaff();
    const agent = await staffAgent();

    const response = await agent.patch('/api/v1/admin/settings').send({
      decisions: { fees: { status: 'CONFIRMED', note: "Client's email, 3 October" } },
      roadsideAssistance: { phone: '0800 123 456' },
    });
    expect(response.status).toBe(200);
    expect(response.body.settings.decisions.fees).toEqual({
      status: 'CONFIRMED',
      note: "Client's email, 3 October",
    });
    expect(response.body.settings.decisions.cancellation.status).toBe('PENDING');

    const entry = await AuditLogModel.findOne({ action: 'settings.update' }).lean();
    expect(String(entry?.actorId)).toBe(admin.id);
    expect(entry?.entityId).toBe('decisions,roadsideAssistance');
    expect(entry?.before).toMatchObject({ roadsideAssistance: { phone: '' } });
    expect(entry?.after).toMatchObject({ roadsideAssistance: { phone: '0800 123 456' } });

    const policies = await request(testApp()).get('/api/v1/policies');
    expect(policies.body.roadsideAssistance).toEqual({ phone: '0800 123 456' });
  });

  it('refuses invalid values with a message per field, and saves nothing', async () => {
    await createStaff();
    const agent = await staffAgent();
    const send = (body: object) => agent.patch('/api/v1/admin/settings').send(body);

    const badTier = await send({ cancellation: { ...DEFAULT_SETTINGS.cancellation, defaultTier: 'NONE' } });
    expect(badTier.status).toBe(400);
    expect(badTier.body.error.fields).toHaveProperty(['cancellation.defaultTier']);

    const badFee = await send({ fees: { ...DEFAULT_SETTINGS.fees, guestServiceFeePct: 150 } });
    expect(badFee.body.error.fields).toHaveProperty(['fees.guestServiceFeePct']);

    const unknown = await send({ somethingElse: true });
    expect(unknown.status).toBe(400);

    const renamed = await send({
      cancellation: {
        ...DEFAULT_SETTINGS.cancellation,
        tiers: DEFAULT_SETTINGS.cancellation.tiers.map((tier, index) =>
          index === 0 ? { ...tier, code: 'EASY' } : tier,
        ),
        hostSelectableTiers: ['EASY', 'MODERATE', 'STRICT'],
      },
    });
    expect(renamed.body.error.fields['cancellation.tiers']).toMatch(/code change/);

    const settings = await agent.get('/api/v1/admin/settings');
    expect(settings.body.settings).toEqual(DEFAULT_SETTINGS);
    expect(await AuditLogModel.countDocuments({ action: 'settings.update' })).toBe(0);
  });
});
