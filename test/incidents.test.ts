import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { ConditionReportModel } from '../src/modules/inspections/condition-report.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { PayoutModel } from '../src/modules/payouts/payout.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

const HOUR_MS = 60 * 60 * 1000;
type Agent = ReturnType<typeof browserAgent>;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

async function trip(overrides: Parameters<typeof createBookingRecord>[1] = {}) {
  const host = await createHost();
  const guest = await createUser({ email: 'kiri@example.co.nz' });
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord(
    { guestId: guest._id, hostId: host._id, vehicleId: vehicle._id },
    overrides,
  );
  return {
    host,
    guest,
    booking,
    guestAgent: await signIn('kiri@example.co.nz'),
    hostAgent: await signIn('hana@example.co.nz'),
  };
}

async function evidence(agent: Agent, ref: string) {
  const body = Buffer.from('%PDF-1.4 receipt');
  const target = await agent
    .post('/api/v1/uploads/signature')
    .send({ purpose: 'INCIDENT_FILE', bookingId: ref, contentType: 'application/pdf', size: body.length });
  expect(target.status).toBe(200);
  await agent.put(new URL(target.body.url).pathname).set('Content-Type', 'application/pdf').send(body);
  return { key: target.body.key as string, name: 'receipt.pdf', contentType: 'application/pdf' };
}

describe('incidents', () => {
  it('opens a case with evidence, holds payouts, and keeps internal notes from the parties', async () => {
    const { booking, guestAgent, hostAgent, host } = await trip({ status: 'ACTIVE' });
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21360,
      scheduledFor: new Date(),
    });
    const file = await evidence(guestAgent, booking.ref);
    const opened = await guestAgent.post('/api/v1/incidents').send({
      bookingRef: booking.ref,
      type: 'BREAKDOWN',
      description: 'Flat battery at the lookout, car won’t start.',
      attachments: [file],
    });
    expect(opened.status).toBe(201);
    const caseRef = opened.body.incident.caseRef as string;
    expect(caseRef).toMatch(/^IN-[A-Z0-9]{6}$/);
    expect(opened.body.incident).toMatchObject({ status: 'OPEN', reportedBy: 'GUEST', role: 'GUEST' });
    expect(opened.body.incident.events[0].attachments[0].url).toMatch(/\/files\/private\/bookings\//);
    expect(await PayoutModel.findOne({ bookingId: booking._id })).toMatchObject({
      status: 'HELD',
      holdReason: 'INCIDENT',
    });
    expect(
      await NotificationModel.countDocuments({ type: 'INCIDENT_UPDATE', userId: host._id, channel: 'EMAIL' }),
    ).toBe(1);

    expect((await hostAgent.get('/api/v1/incidents')).body.incidents[0]).toMatchObject({
      caseRef,
      role: 'HOST',
    });
    const reply = await hostAgent
      .post(`/api/v1/incidents/${caseRef}/events`)
      .send({ note: 'Sorry! Roadside is on the way.' });
    expect(reply.status).toBe(201);

    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    expect((await staff.get('/api/v1/admin/incidents')).body.incidents).toHaveLength(1);
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'Host was slow to answer.', visibility: 'INTERNAL', assignToMe: true });
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'Battery replaced, all sorted.', status: 'RESOLVED', visibility: 'BOTH' });

    const seen = await guestAgent.get(`/api/v1/incidents/${caseRef}`);
    expect(seen.body.incident.status).toBe('RESOLVED');
    expect(seen.body.incident.events.map((event: { note?: string }) => event.note)).toEqual([
      'Flat battery at the lookout, car won’t start.',
      'Sorry! Roadside is on the way.',
      'Battery replaced, all sorted.',
    ]);
    const forStaff = await staff.get(`/api/v1/admin/incidents/${caseRef}`);
    expect(forStaff.body.incident.events).toHaveLength(4);
    expect(forStaff.body.incident.assignedTo).toBe('Aroha');
    // Resolved: the payout is free to go.
    expect(await PayoutModel.findOne({ bookingId: booking._id })).toMatchObject({ status: 'SCHEDULED' });
    expect(await AuditLogModel.countDocuments({ action: 'incident.updated' })).toBe(2);
    expect(
      (await guestAgent.post(`/api/v1/incidents/${caseRef}/events`).send({ note: 'Thanks' })).body.error.code,
    ).toBe('CASE_CLOSED');
  });

  it('takes damage reports only within the window after check-out, and only from the booking’s parties', async () => {
    const { booking, hostAgent, guest } = await trip({ status: 'COMPLETED' });
    await ConditionReportModel.create({
      bookingId: booking._id,
      stage: 'CHECK_OUT',
      submittedBy: guest._id,
      odometer: 1000,
      fuelOrBatteryPct: 50,
      photos: [],
    });
    await ConditionReportModel.collection.updateOne(
      { bookingId: booking._id },
      { $set: { createdAt: new Date(Date.now() - 49 * HOUR_MS) } },
    );
    const late = await hostAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'DAMAGE', description: 'Dent in the passenger door.' });
    expect(late.body.error.code).toBe('DAMAGE_WINDOW_CLOSED');
    // A toll notice can arrive weeks later.
    const toll = await hostAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'TOLL', description: 'Unpaid toll on the Northern Gateway.' });
    expect(toll.status).toBe(201);

    await createUser({ email: 'nosy@example.co.nz' });
    const nosy = await signIn('nosy@example.co.nz');
    expect(
      (
        await nosy
          .post('/api/v1/incidents')
          .send({ bookingRef: booking.ref, type: 'OTHER', description: 'Not my booking at all.' })
      ).status,
    ).toBe(404);
    expect((await nosy.get(`/api/v1/incidents/${toll.body.incident.caseRef}`)).status).toBe(404);
  });

  it('adds a charge to the guest from a resolved case', async () => {
    const { booking, guestAgent } = await trip({ status: 'COMPLETED' });
    const opened = await guestAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'CLEANING', description: 'Sand all through the back seat.' });
    const caseRef = opened.body.incident.caseRef;
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();

    const early = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/charges`)
      .send({ type: 'CLEANING', description: 'Interior clean', amountCents: 8000 });
    expect(early.body.error.code).toBe('NOT_RESOLVED');
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ status: 'RESOLVED', note: 'Cleaning needed.' });
    const charged = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/charges`)
      .send({ type: 'CLEANING', description: 'Interior clean', amountCents: 8000 });
    expect(charged.status).toBe(200);
    expect(charged.body.incident.extraCharges).toEqual([
      { type: 'CLEANING', description: 'Interior clean', amountCents: 8000, status: 'PENDING' },
    ]);
    const saved = await BookingModel.findById(booking._id);
    expect(saved!.extraCharges[0]!.incidentId!.toString()).toBe((await IncidentModel.findOne())!.id);
    expect(await JobModel.countDocuments({ type: 'extraCharge.collect' })).toBe(1);

    // Support without the refunds permission can't charge.
    await createStaff('mere@example.co.nz', 'SUPPORT');
    await UserModel.updateOne({ email: 'mere@example.co.nz' }, { $set: { permissions: [] } });
    const support = await staffAgent('mere@example.co.nz');
    expect(
      (
        await support
          .post(`/api/v1/admin/incidents/${caseRef}/charges`)
          .send({ type: 'FUEL', description: 'Fuel', amountCents: 5000 })
      ).status,
    ).toBe(403);
  });
});
