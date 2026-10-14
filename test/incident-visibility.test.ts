import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent } from './helpers.js';

/*
 * Who sees what on a case (spec §15): a party's answer to a question support asked them alone stays
 * between them and support; taking a case is internal; an update goes to whoever already sees the case
 * unless staff choose otherwise; a reply doesn't reopen a case closed at the same moment; and charges
 * stay within the protection plan's excess, once per submit.
 */

type Agent = ReturnType<typeof browserAgent>;
type Event = { note?: string; visibility: string; action: string; status?: string };

afterEach(() => {
  vi.restoreAllMocks();
});

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
    { status: 'ACTIVE', ...overrides },
  );
  await createStaff('aroha@example.co.nz', 'ADMIN');
  return {
    host,
    guest,
    booking,
    guestAgent: await signIn('kiri@example.co.nz'),
    hostAgent: await signIn('hana@example.co.nz'),
    staff: await staffAgent(),
  };
}

const view = async (agent: Agent, caseRef: string) =>
  (await agent.get(`/api/v1/incidents/${caseRef}`)).body.incident;
const notes = (incident: { events: Event[] }) => incident.events.map((event) => event.note);
const updatesFor = (userId: unknown) =>
  NotificationModel.countDocuments({ type: 'INCIDENT_UPDATE', channel: 'EMAIL', userId });

async function guestReport(agent: Agent, bookingRef: string, type = 'BREAKDOWN') {
  const opened = await agent
    .post('/api/v1/incidents')
    .send({ bookingRef, type, description: 'Warning light and no power on the motorway.' });
  expect(opened.status).toBe(201);
  return opened.body.incident.caseRef as string;
}

describe('a party’s reply', () => {
  it('on a case a party reported: both parties see it', async () => {
    const { booking, guestAgent, hostAgent, guest } = await trip();
    const caseRef = await guestReport(guestAgent, booking.ref);
    expect((await view(hostAgent, caseRef)).sharedWithOtherParty).toBe(true);

    const reply = await hostAgent
      .post(`/api/v1/incidents/${caseRef}/events`)
      .send({ note: 'Roadside is on the way.' });
    expect(reply.body.incident.events.at(-1)).toMatchObject({ visibility: 'BOTH' });
    expect(notes(await view(guestAgent, caseRef))).toContain('Roadside is on the way.');
    expect(await updatesFor(guest._id)).toBe(1);
  });

  it('on a case support opened with one party: only that party and support see it', async () => {
    const { booking, guestAgent, hostAgent, staff, host } = await trip();
    const opened = await staff.post('/api/v1/admin/incidents').send({
      bookingRef: booking.ref,
      type: 'FINE',
      description: 'A speed camera notice arrived for this trip.',
      visibility: 'GUEST',
    });
    const caseRef = opened.body.incident.caseRef as string;
    expect((await view(guestAgent, caseRef)).sharedWithOtherParty).toBe(false);

    const reply = await guestAgent
      .post(`/api/v1/incidents/${caseRef}/events`)
      .send({ note: 'I was driving, sorry.' });
    expect(reply.body.incident.events.at(-1)).toMatchObject({ visibility: 'GUEST' });
    expect((await hostAgent.get(`/api/v1/incidents/${caseRef}`)).status).toBe(404);
    expect(await updatesFor(host._id)).toBe(0);
  });

  it('answering a question support asked them alone: stays between them and support', async () => {
    const { booking, guestAgent, hostAgent, staff, host } = await trip();
    const caseRef = await guestReport(guestAgent, booking.ref, 'ACCIDENT');
    expect(await updatesFor(host._id)).toBe(1);

    const asked = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'Was anyone else driving?', status: 'AWAITING_RESPONSE', visibility: 'GUEST' });
    expect(asked.status).toBe(200);
    // The Guest's next update is for support only; the Host's is still for both.
    expect((await view(guestAgent, caseRef)).sharedWithOtherParty).toBe(false);
    expect((await view(hostAgent, caseRef)).sharedWithOtherParty).toBe(true);
    // Support wait for the Guest's answer, not the Host's, in the case and in each one's list.
    expect((await view(guestAgent, caseRef)).awaitingYou).toBe(true);
    expect((await view(hostAgent, caseRef)).awaitingYou).toBe(false);
    expect((await guestAgent.get('/api/v1/incidents')).body.incidents[0].awaitingYou).toBe(true);
    expect((await hostAgent.get('/api/v1/incidents')).body.incidents[0].awaitingYou).toBe(false);

    const answer = await guestAgent
      .post(`/api/v1/incidents/${caseRef}/events`)
      .send({ note: 'My partner was, for an hour.' });
    expect(answer.status).toBe(201);
    expect(answer.body.incident).toMatchObject({ status: 'INVESTIGATING', awaitingYou: false });
    expect(answer.body.incident.events.at(-1)).toMatchObject({
      visibility: 'GUEST',
      status: 'INVESTIGATING',
    });
    // The Host neither sees the answer nor hears about it.
    expect(notes(await view(hostAgent, caseRef))).not.toContain('My partner was, for an hour.');
    expect(await updatesFor(host._id)).toBe(1);

    // Once support writes to both again, the Guest's updates are for both again.
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'We’re checking the insurance details.', visibility: 'BOTH' });
    expect((await view(guestAgent, caseRef)).sharedWithOtherParty).toBe(true);
  });

  it('after a question support noted for the team only: back with support, shared as the case is', async () => {
    const { booking, guestAgent, hostAgent, staff, guest } = await trip();
    const caseRef = await guestReport(guestAgent, booking.ref);
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'Waiting on the roadside report.', status: 'AWAITING_RESPONSE', visibility: 'INTERNAL' });
    expect((await view(hostAgent, caseRef)).sharedWithOtherParty).toBe(true);
    // Neither party saw a question, so either may answer it.
    expect((await view(hostAgent, caseRef)).awaitingYou).toBe(true);
    expect((await view(guestAgent, caseRef)).awaitingYou).toBe(true);

    const reply = await hostAgent
      .post(`/api/v1/incidents/${caseRef}/events`)
      .send({ note: 'Here’s the roadside report.' });
    expect(reply.body.incident.status).toBe('INVESTIGATING');
    expect(reply.body.incident.events.at(-1)).toMatchObject({ visibility: 'BOTH' });
    expect(notes(await view(guestAgent, caseRef))).toContain('Here’s the roadside report.');
    expect(await updatesFor(guest._id)).toBe(1);
  });

  it('doesn’t reopen a case support resolved at the same moment', async () => {
    const { booking, guestAgent, staff } = await trip();
    const caseRef = await guestReport(guestAgent, booking.ref);
    // The Guest's page still shows it open as support resolves it.
    const seen = await IncidentModel.findOne({ caseRef }).lean();
    await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'Battery replaced, all sorted.', status: 'RESOLVED' });
    vi.spyOn(IncidentModel, 'findOne').mockReturnValueOnce({ lean: async () => seen } as never);

    const late = await guestAgent.post(`/api/v1/incidents/${caseRef}/events`).send({ note: 'Thanks!' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CASE_CHANGED');
    const kept = await IncidentModel.findOne({ caseRef }).lean();
    expect(kept).toMatchObject({ status: 'RESOLVED' });
    expect(kept!.events.map((event) => event.note)).not.toContain('Thanks!');
  });
});

describe('staff updates', () => {
  it('keeps taking the case internal, whatever the form chose, and tells nobody', async () => {
    const { booking, guestAgent, hostAgent, staff, guest, host } = await trip();
    const opened = await staff.post('/api/v1/admin/incidents').send({
      bookingRef: booking.ref,
      type: 'OTHER',
      description: 'Possible fraud: the card belongs to someone else.',
      visibility: 'INTERNAL',
    });
    const caseRef = opened.body.incident.caseRef as string;
    expect(opened.body.incident.audience).toBe('INTERNAL');

    const taken = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ assignToMe: true, visibility: 'BOTH' });
    expect(taken.status).toBe(200);
    expect(taken.body.incident.events.at(-1)).toMatchObject({ action: 'ASSIGNED', visibility: 'INTERNAL' });
    expect(taken.body.incident.audience).toBe('INTERNAL');

    // Resolved with no choice of who sees it, then a charge: both stay with the team.
    await staff.post(`/api/v1/admin/incidents/${caseRef}/events`).send({ status: 'RESOLVED' });
    const charged = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/charges`)
      .send({ type: 'OTHER', description: 'Card dispute fee', amountCents: 2500 });
    expect(charged.status).toBe(200);
    expect(
      charged.body.incident.events.map((event: Event) => [event.action, event.visibility]).slice(-2),
    ).toEqual([
      ['STATUS', 'INTERNAL'],
      ['CHARGE_ADDED', 'INTERNAL'],
    ]);
    for (const agent of [guestAgent, hostAgent]) {
      expect((await agent.get(`/api/v1/incidents/${caseRef}`)).status).toBe(404);
    }
    expect(await updatesFor(guest._id)).toBe(0);
    expect(await updatesFor(host._id)).toBe(0);
  });

  it('sends an update to whoever already sees the case unless staff choose otherwise', async () => {
    const { booking, guestAgent, hostAgent, staff, guest, host } = await trip();
    const opened = await staff.post('/api/v1/admin/incidents').send({
      bookingRef: booking.ref,
      type: 'DAMAGE',
      description: 'The next guest found a scratch on the bumper.',
      visibility: 'HOST',
    });
    const caseRef = opened.body.incident.caseRef as string;
    expect(opened.body.incident.audience).toBe('HOST');
    expect(await updatesFor(host._id)).toBe(1);

    // A status change with no choice of who sees it: the Host, as before.
    const moved = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ status: 'INVESTIGATING' });
    expect(moved.body.incident.events.at(-1)).toMatchObject({ action: 'STATUS', visibility: 'HOST' });
    expect((await guestAgent.get(`/api/v1/incidents/${caseRef}`)).status).toBe(404);
    expect(await updatesFor(guest._id)).toBe(0);
    expect(await updatesFor(host._id)).toBe(2);

    // Shared with both when staff choose it.
    const shared = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ note: 'We’ve asked the guest about the bumper.', visibility: 'BOTH' });
    expect(shared.body.incident.audience).toBe('BOTH');
    expect((await view(hostAgent, caseRef)).status).toBe('INVESTIGATING');
    expect(notes(await view(guestAgent, caseRef))).toEqual(['We’ve asked the guest about the bumper.']);
  });
});

describe('charges from a case', () => {
  const PLAN = {
    code: 'BASIC',
    name: 'Basic protection',
    priceCents: 4500,
    excessCents: 200_000,
    coverSummary: 'Damage cover above a $2,000 excess',
    mandatory: true,
  };

  async function resolvedCase(type: string) {
    const parts = await trip({ status: 'COMPLETED', protectionPlan: PLAN });
    const caseRef = await parts.guestAgent
      .post('/api/v1/incidents')
      .send({ bookingRef: parts.booking.ref, type, description: 'Dent in the rear door after the trip.' })
      .then((response) => response.body.incident.caseRef as string);
    await parts.staff
      .post(`/api/v1/admin/incidents/${caseRef}/events`)
      .send({ status: 'RESOLVED', note: 'The guest agrees to pay for the repair.' });
    return { ...parts, caseRef };
  }

  it('keeps a damage case’s charges within the protection plan’s excess', async () => {
    const { staff, caseRef, booking } = await resolvedCase('DAMAGE');
    const charge = (body: object) => staff.post(`/api/v1/admin/incidents/${caseRef}/charges`).send(body);

    const shown = (await staff.get(`/api/v1/admin/incidents/${caseRef}`)).body.incident;
    expect(shown).toMatchObject({
      protectionPlan: { name: 'Basic protection', excessCents: 200_000 },
      chargeLimitCents: 200_000,
    });
    // The parties don't see the limit.
    expect(shown.role).toBe('STAFF');

    const first = await charge({ type: 'DAMAGE', description: 'Door repair', amountCents: 150_000 });
    expect(first.status).toBe(200);
    expect(first.body.incident.chargeLimitCents).toBe(50_000);

    const over = await charge({ type: 'DAMAGE', description: 'Paint', amountCents: 60_000 });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({
      code: 'OVER_EXCESS',
      fields: { amountCents: expect.stringMatching(/\$500\.00/) },
    });

    const rest = await charge({ type: 'DAMAGE', description: 'Paint', amountCents: 50_000 });
    expect(rest.body.incident.chargeLimitCents).toBe(0);
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toHaveLength(2);
  });

  it('keeps two charges made at the same moment within the excess together', async () => {
    const { staff, caseRef, booking } = await resolvedCase('DAMAGE');
    const charge = (description: string, idempotencyKey: string) =>
      staff
        .post(`/api/v1/admin/incidents/${caseRef}/charges`)
        .send({ type: 'DAMAGE', description, amountCents: 150_000, idempotencyKey });

    // Two staff, each seeing $2,000 of room, charge $1,500 at once.
    const outcomes = await Promise.all([
      charge('Door repair', '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d'),
      charge('Bumper repair', '6f5e4d3c-2b1a-4c9d-8e7f-6a5b4c3d2e1f'),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 409]);
    const refused = outcomes.find((outcome) => outcome.status === 409)!;
    expect(refused.body.error).toMatchObject({
      code: 'OVER_EXCESS',
      fields: { amountCents: expect.stringMatching(/\$500\.00/) },
    });
    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toHaveLength(1);
    const events = (await IncidentModel.findOne({ caseRef }).lean())!.events;
    expect(events.filter((event) => event.action === 'CHARGE_ADDED')).toHaveLength(1);
  });

  it('adds one charge for a submit sent twice', async () => {
    const { staff, caseRef, booking } = await resolvedCase('CLEANING');
    const body = {
      type: 'CLEANING',
      description: 'Interior clean',
      amountCents: 8000,
      idempotencyKey: 'f5d0c2a4-8e1b-4f53-9c51-0e2b7d1a9c33',
    };
    const charge = () => staff.post(`/api/v1/admin/incidents/${caseRef}/charges`).send(body);

    // Two at once (a double click), then once more (a retry after a lost response).
    const [one, two] = await Promise.all([charge(), charge()]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const again = await charge();
    expect(again.status).toBe(200);
    expect(again.body.incident.extraCharges).toHaveLength(1);
    // A cleaning case isn't limited by the protection plan.
    expect(again.body.incident.chargeLimitCents).toBeUndefined();
    expect(again.body.incident.protectionPlan).toMatchObject({ excessCents: 200_000 });

    expect((await BookingModel.findById(booking._id).lean())!.extraCharges).toHaveLength(1);
    expect(await JobModel.countDocuments({ type: 'extraCharge.collect' })).toBe(1);
    const events = (await IncidentModel.findOne({ caseRef }).lean())!.events;
    expect(events.filter((event) => event.action === 'CHARGE_ADDED')).toHaveLength(1);

    // A new submit is a new charge.
    const next = await staff
      .post(`/api/v1/admin/incidents/${caseRef}/charges`)
      .send({ ...body, idempotencyKey: '0c6f1e2d-3b4a-4c5d-8e9f-a1b2c3d4e5f6' });
    expect(next.body.incident.extraCharges).toHaveLength(2);
  });

  it('writes the case’s entry on a retry when the first try stopped after adding the charge', async () => {
    const { staff, caseRef } = await resolvedCase('CLEANING');
    const body = {
      type: 'CLEANING',
      description: 'Interior clean',
      amountCents: 8000,
      idempotencyKey: '7a1c9e40-5b2d-4e8f-a3c6-d9e0f1a2b3c4',
    };
    // The case's entry fails once, after the charge is on the booking.
    const appendOnce = vi
      .spyOn(IncidentModel, 'findOneAndUpdate')
      .mockRejectedValueOnce(new Error('timeout'));
    const first = await staff.post(`/api/v1/admin/incidents/${caseRef}/charges`).send(body);
    expect(first.status).toBe(500);
    appendOnce.mockRestore();
    const charged = async () => (await IncidentModel.findOne({ caseRef }).lean())!.events;
    expect((await charged()).filter((event) => event.action === 'CHARGE_ADDED')).toHaveLength(0);

    const retry = await staff.post(`/api/v1/admin/incidents/${caseRef}/charges`).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.incident.extraCharges).toHaveLength(1);
    expect((await charged()).filter((event) => event.action === 'CHARGE_ADDED')).toHaveLength(1);
    // And only once.
    await staff.post(`/api/v1/admin/incidents/${caseRef}/charges`).send(body);
    expect((await charged()).filter((event) => event.action === 'CHARGE_ADDED')).toHaveLength(1);
  });
});

describe('the staff list of cases', () => {
  it('comes a page at a time, last updated first, with the total', async () => {
    const { guest, booking, staff } = await trip();
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    // Straight to the collection, so each case keeps the update time given here.
    await IncidentModel.collection.insertMany(
      Array.from({ length: 52 }, (_, index) => ({
        caseRef: `IN-PAGE${String(index).padStart(2, '0')}`,
        bookingId: booking._id,
        reporterId: guest._id,
        type: 'OTHER',
        description: `Case ${index}`,
        status: index === 51 ? 'CLOSED' : 'OPEN',
        createdAt: at(60),
        updatedAt: at(index),
        events: [],
      })),
    );

    const first = await staff.get('/api/v1/admin/incidents');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 51, page: 1 });
    expect(first.body.incidents).toHaveLength(50);
    expect(first.body.incidents[0].caseRef).toBe('IN-PAGE00');
    const second = await staff.get('/api/v1/admin/incidents').query({ page: 2 });
    expect(second.body.incidents.map((incident: { caseRef: string }) => incident.caseRef)).toEqual([
      'IN-PAGE50',
    ]);
    const closed = await staff.get('/api/v1/admin/incidents').query({ status: 'CLOSED' });
    expect(closed.body).toMatchObject({ total: 1, page: 1 });
    expect((await staff.get('/api/v1/admin/incidents').query({ status: 'NOPE' })).status).toBe(400);
  });
});
