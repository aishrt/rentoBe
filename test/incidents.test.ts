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
    // A toll notice can arrive weeks later, reported with the notice itself.
    const notice = await evidence(hostAgent, booking.ref);
    const toll = await hostAgent.post('/api/v1/incidents').send({
      bookingRef: booking.ref,
      type: 'TOLL',
      description: 'Unpaid toll on the Northern Gateway.',
      attachments: [notice],
    });
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

  it('lets staff assign a case to any staff member, or to nobody', async () => {
    const { booking, guestAgent, guest } = await trip({ status: 'ACTIVE' });
    const opened = await guestAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'BREAKDOWN', description: 'Warning light and no power.' });
    const caseRef = opened.body.incident.caseRef as string;
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const mere = await createStaff('mere@example.co.nz', 'SUPPORT');
    await UserModel.updateOne({ _id: mere._id }, { $set: { firstName: 'Mere' } });
    const away = await createStaff('tama@example.co.nz', 'SUPPORT');
    await UserModel.updateOne({ _id: away._id }, { $set: { firstName: 'Tama', status: 'SUSPENDED' } });

    // Support, not only the admin, can see who's on the team and hand cases over.
    const support = await staffAgent('mere@example.co.nz');
    const team = await support.get('/api/v1/admin/incidents/assignees');
    expect(team.status).toBe(200);
    expect(team.body.assignees).toEqual([
      { id: expect.any(String), name: 'Aroha Tester', you: false },
      { id: mere.id, name: 'Mere Tester', you: true },
    ]);

    const admin = await staffAgent();
    const assigned = await admin
      .post(`/api/v1/admin/incidents/${caseRef}/assignee`)
      .send({ userId: mere.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.incident).toMatchObject({ assignedTo: 'Mere', assignedToId: mere.id });
    expect(assigned.body.incident.events.at(-1)).toMatchObject({
      action: 'ASSIGNED',
      byName: 'Aroha',
      assignedTo: 'Mere',
      visibility: 'INTERNAL',
    });
    expect(
      await NotificationModel.findOne({ userId: mere._id, type: 'INCIDENT_ASSIGNED', channel: 'IN_APP' }),
    ).toMatchObject({ payload: { link: `/admin/incidents/${caseRef}` } });
    expect(await AuditLogModel.findOne({ action: 'incident.assigned' })).toMatchObject({
      before: { assignedTo: null },
      after: { assignedTo: mere.id },
    });
    expect((await admin.get('/api/v1/admin/incidents')).body.incidents[0]).toMatchObject({
      assignedTo: 'Mere',
      assignedToId: mere.id,
    });

    // Only staff who can work: not a guest, not a suspended account.
    for (const userId of [guest.id, away.id]) {
      const refused = await admin.post(`/api/v1/admin/incidents/${caseRef}/assignee`).send({ userId });
      expect(refused.body.error.code).toBe('NOT_STAFF');
    }

    // The same person again changes nothing; null leaves it with nobody.
    const same = await support.post(`/api/v1/admin/incidents/${caseRef}/assignee`).send({ userId: mere.id });
    expect(same.body.incident.events).toHaveLength(2);
    const cleared = await support.post(`/api/v1/admin/incidents/${caseRef}/assignee`).send({ userId: null });
    expect(cleared.body.incident.assignedTo).toBeUndefined();
    expect(cleared.body.incident.events.at(-1)).toMatchObject({ action: 'UNASSIGNED', by: 'YOU' });
    // Taking it yourself names nobody else, and tells nobody.
    const taken = await support.post(`/api/v1/admin/incidents/${caseRef}/assignee`).send({ userId: mere.id });
    expect(taken.body.incident.events.at(-1)).toMatchObject({ action: 'ASSIGNED', by: 'YOU' });
    expect(taken.body.incident.events.at(-1).assignedTo).toBeUndefined();
    expect(
      await NotificationModel.countDocuments({
        userId: mere._id,
        type: 'INCIDENT_ASSIGNED',
        channel: 'IN_APP',
      }),
    ).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'incident.assigned' })).toBe(3);

    // The parties never see who on the team has it.
    const seen = (await guestAgent.get(`/api/v1/incidents/${caseRef}`)).body.incident;
    expect(seen.events.map((event: { action: string }) => event.action)).toEqual(['OPENED']);
    expect(seen.assignedToId).toBeUndefined();
  });

  it('moves a case only along its workflow, and holds payouts again when it’s reopened', async () => {
    const { booking, guestAgent, guest, host } = await trip({ status: 'COMPLETED' });
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21360,
      scheduledFor: new Date(),
    });
    const opened = await guestAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'CLEANING', description: 'Sand all through the back seat.' });
    const caseRef = opened.body.incident.caseRef as string;
    expect(opened.body.incident.nextStatuses).toBeUndefined();
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    const update = (body: object) => staff.post(`/api/v1/admin/incidents/${caseRef}/events`).send(body);
    const payout = async () => PayoutModel.findOne({ bookingId: booking._id }).lean();

    expect((await staff.get(`/api/v1/admin/incidents/${caseRef}`)).body.incident.nextStatuses).toEqual([
      'INVESTIGATING',
      'AWAITING_RESPONSE',
      'RESOLVED',
      'CLOSED',
    ]);
    const resolved = await update({ status: 'RESOLVED', note: 'Cleaning needed.' });
    expect(resolved.body.incident.nextStatuses).toEqual(['INVESTIGATING', 'AWAITING_RESPONSE', 'CLOSED']);
    expect(await payout()).toMatchObject({ status: 'SCHEDULED' });

    // Nothing goes back to OPEN.
    const back = await update({ status: 'OPEN' });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('INVALID_STATUS_CHANGE');

    // Reopened when the guest disputes it: the payout waits for the case again, and both parties hear.
    const reopened = await update({ status: 'INVESTIGATING', note: 'The guest disputes the cleaning.' });
    expect(reopened.status).toBe(200);
    expect(await payout()).toMatchObject({ status: 'HELD', holdReason: 'INCIDENT' });
    expect(
      await NotificationModel.countDocuments({
        userId: guest._id,
        type: 'INCIDENT_UPDATE',
        channel: 'IN_APP',
        'payload.title': `Case reopened: case ${caseRef}`,
      }),
    ).toBe(1);

    // Closed is final: a note is fine, a new status isn't.
    await update({ status: 'CLOSED' });
    expect(await payout()).toMatchObject({ status: 'SCHEDULED' });
    const again = await update({ status: 'INVESTIGATING' });
    expect(again.body.error.code).toBe('INVALID_STATUS_CHANGE');
    expect((await update({ note: 'Filed with the cleaning receipts.', visibility: 'INTERNAL' })).status).toBe(
      200,
    );
    expect(await IncidentModel.findOne({ caseRef }).lean()).toMatchObject({ status: 'CLOSED' });
  });

  it('lets staff open a case outside the damage window, for one party or the team', async () => {
    const { booking, guest, host, guestAgent, hostAgent } = await trip({ status: 'COMPLETED' });
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
      { $set: { createdAt: new Date(Date.now() - 10 * 24 * HOUR_MS) } },
    );
    await PayoutModel.create({
      hostId: host._id,
      bookingId: booking._id,
      type: 'TRIP',
      amountCents: 21360,
      scheduledFor: new Date(),
    });
    const report = {
      bookingRef: booking.ref,
      type: 'DAMAGE',
      description: 'Scratch on the rear bumper, found by the next guest.',
    };
    // The window is closed for the parties.
    expect((await hostAgent.post('/api/v1/incidents').send(report)).body.error.code).toBe(
      'DAMAGE_WINDOW_CLOSED',
    );
    // Only staff open cases here.
    expect((await guestAgent.post('/api/v1/admin/incidents').send(report)).status).toBe(403);

    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    const opened = await staff.post('/api/v1/admin/incidents').send({ ...report, visibility: 'HOST' });
    expect(opened.status).toBe(201);
    const caseRef = opened.body.incident.caseRef as string;
    expect(caseRef).toMatch(/^IN-[A-Z0-9]{6}$/);
    expect(opened.body.incident).toMatchObject({
      status: 'OPEN',
      reportedBy: 'SUPPORT',
      role: 'STAFF',
      assignedTo: 'Aroha',
      events: [expect.objectContaining({ action: 'OPENED', by: 'YOU', visibility: 'HOST' })],
    });
    expect(await PayoutModel.findOne({ bookingId: booking._id }).lean()).toMatchObject({
      status: 'HELD',
      holdReason: 'INCIDENT',
    });
    expect(await AuditLogModel.findOne({ action: 'incident.opened' }).lean()).toMatchObject({
      after: { caseRef, bookingRef: booking.ref, type: 'DAMAGE', visibility: 'HOST' },
    });

    // Only the Host is told, and only the Host sees it.
    expect(
      await NotificationModel.countDocuments({ type: 'INCIDENT_UPDATE', userId: host._id, channel: 'EMAIL' }),
    ).toBe(1);
    expect(await NotificationModel.countDocuments({ type: 'INCIDENT_UPDATE', userId: guest._id })).toBe(0);
    expect((await hostAgent.get('/api/v1/incidents')).body.incidents).toEqual([
      expect.objectContaining({ caseRef, reportedBy: 'SUPPORT', role: 'HOST' }),
    ]);
    expect((await guestAgent.get('/api/v1/incidents')).body.incidents).toEqual([]);
    expect((await guestAgent.get(`/api/v1/incidents/${caseRef}`)).status).toBe(404);

    // Shared with both later: the Guest sees the case, but not the note written for the Host.
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'We’ve asked the guest about the bumper.', visibility: 'BOTH' });
    const seen = await guestAgent.get(`/api/v1/incidents/${caseRef}`);
    expect(seen.status).toBe(200);
    expect(seen.body.incident.description).toBe('Opened by Rento Vroom support.');
    expect(seen.body.incident.events.map((event: { note?: string }) => event.note)).toEqual([
      'We’ve asked the guest about the bumper.',
    ]);

    // A booking that doesn't exist.
    const missing = await staff.post('/api/v1/admin/incidents').send({ ...report, bookingRef: 'RV-ZZZZZZ' });
    expect(missing.status).toBe(404);
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

describe('staff alerts on a party’s update', () => {
  it('alerts the whole team while nobody has the case, then only whoever has it', async () => {
    const { booking, guestAgent, hostAgent } = await trip({ status: 'ACTIVE' });
    const aroha = await createStaff('aroha@example.co.nz', 'ADMIN');
    const mere = await createStaff('mere@example.co.nz', 'SUPPORT');
    const opened = await guestAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: booking.ref, type: 'BREAKDOWN', description: 'Warning light and no power.' });
    const caseRef = opened.body.incident.caseRef as string;
    const updates = (userId: unknown, channel = 'IN_APP') =>
      NotificationModel.countDocuments({ type: 'INCIDENT_UPDATE', channel, userId });

    // Nobody has it yet: the whole team hears about the host's update, in the portal and by email.
    await hostAgent.post(`/api/v1/incidents/${caseRef}/events`).send({ note: 'Roadside is on the way.' });
    expect(await updates(aroha._id)).toBe(1);
    expect(await updates(mere._id)).toBe(1);
    expect(await updates(mere._id, 'EMAIL')).toBe(1);
    expect(
      await NotificationModel.findOne({ type: 'INCIDENT_UPDATE', channel: 'IN_APP', userId: mere._id }),
    ).toMatchObject({
      payload: {
        title: `The host added to case ${caseRef}`,
        body: `The host added to the breakdown case on booking ${booking.ref}: Roadside is on the way.`,
        link: `/admin/incidents/${caseRef}`,
      },
    });

    // Once Mere has it, only she is told.
    const admin = await staffAgent();
    await admin.post(`/api/v1/admin/incidents/${caseRef}/assignee`).send({ userId: mere.id });
    await guestAgent.post(`/api/v1/incidents/${caseRef}/events`).send({ note: 'Thanks, it’s here now.' });
    expect(await updates(aroha._id)).toBe(1);
    expect(await updates(mere._id)).toBe(2);
  });
});
