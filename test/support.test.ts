import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/jobs/job.model.js';
import { AuditLogModel } from '../src/modules/audit/audit-log.model.js';
import { IncidentModel } from '../src/modules/incidents/incident.model.js';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import { SupportTicketModel } from '../src/modules/support/support-ticket.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import {
  FRONTEND_ORIGIN,
  PASSWORD,
  browserAgent,
  createStaff,
  createUser,
  staffAgent,
  testApp,
} from './helpers.js';

type Agent = ReturnType<typeof browserAgent>;

const contact = {
  name: 'Kiri Tester',
  email: 'kiri@example.co.nz',
  category: 'BOOKING',
  subject: 'Scratch on the bumper',
  message: 'The car had a scratch on the bumper when I picked it up.',
};

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** Uploads a file for a support ticket through the local driver, as the website does. */
async function upload(
  agent: Agent,
  { name = 'receipt.pdf', contentType = 'application/pdf' }: { name?: string; contentType?: string } = {},
) {
  const body = Buffer.from(contentType === 'application/pdf' ? '%PDF-1.4 receipt' : 'photo bytes');
  const target = await agent
    .post('/api/v1/uploads/signature')
    .send({ purpose: 'SUPPORT_FILE', contentType, size: body.length });
  expect(target.status).toBe(200);
  const sent = await agent.put(new URL(target.body.url).pathname).set('Content-Type', contentType).send(body);
  expect(sent.status).toBe(201);
  return { key: target.body.key as string, name, contentType };
}

/** Opens a signed link to a private file, signed out, as a browser following it would. */
function open(url: string) {
  const link = new URL(url);
  return request(testApp()).get(`${link.pathname}${link.search}`);
}

async function ticketFor(userId: unknown, overrides: Record<string, unknown> = {}) {
  return SupportTicketModel.create({
    ref: 'ST-ABC234',
    userId,
    name: 'Kiri Tester',
    email: 'kiri@example.co.nz',
    subject: 'Where do I collect the car?',
    category: 'BOOKING',
    messages: [{ authorId: userId, body: 'Is it at the airport?', createdAt: new Date() }],
    ...overrides,
  });
}

describe('Support ticket attachments', () => {
  it('keeps a member’s files on their new ticket and replies, behind signed links for them and staff', async () => {
    const kiri = await createUser();
    const agent = await signIn(kiri.email);

    // Support files take photos and PDFs, like incident evidence.
    const refused = await agent
      .post('/api/v1/uploads/signature')
      .send({ purpose: 'SUPPORT_FILE', contentType: 'text/plain', size: 10 });
    expect(refused.body.error.fields).toEqual({ contentType: 'Files can be a PDF or a photo' });

    const receipt = await upload(agent);
    expect(receipt.key).toMatch(new RegExp(`^incoming/private/support/${kiri.id}/`));
    const opened = await agent.post('/api/v1/support/tickets').send({ ...contact, attachments: [receipt] });
    expect(opened.status).toBe(201);
    const ref = opened.body.ref as string;

    const photo = await upload(agent, { name: 'bumper.png', contentType: 'image/png' });
    const replied = await agent
      .post(`/api/v1/support/tickets/${ref}/messages`)
      .send({ body: 'Here’s a photo of it.', attachments: [photo] });
    expect(replied.status).toBe(200);

    const own = (await agent.get(`/api/v1/support/tickets/${ref}`)).body.ticket;
    expect(own.messages.map((message: { attachments: unknown[] }) => message.attachments)).toEqual([
      [
        {
          url: expect.stringMatching(/\/files\/private\/support\//),
          name: 'receipt.pdf',
          contentType: 'application/pdf',
        },
      ],
      [
        {
          url: expect.stringMatching(/\/files\/private\/support\//),
          name: 'bumper.png',
          contentType: 'image/png',
        },
      ],
    ]);
    // A signed link opens the file for a short while, without a session.
    const file = await open(own.messages[0].attachments[0].url);
    expect(file.status).toBe(200);
    // Kept by this browser only, while the link works.
    expect(file.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    // The file itself has no address of its own.
    expect((await open(own.messages[0].attachments[0].url.replace(/\?.*$/, ''))).status).toBe(403);

    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    const forStaff = (await staff.get(`/api/v1/admin/support/tickets/${ref}`)).body.ticket;
    expect(forStaff.thread[0].attachments).toEqual([
      expect.objectContaining({
        name: 'receipt.pdf',
        url: expect.stringContaining('/files/private/support/'),
      }),
    ]);
    expect(forStaff.thread[1].attachments[0]).toMatchObject({ name: 'bumper.png', contentType: 'image/png' });
  });

  it('refuses files from a signed-out visitor, another member’s upload and another purpose’s', async () => {
    const signedOut = await request(testApp())
      .post('/api/v1/support/tickets')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ ...contact, attachments: [{ key: 'support/000000000000000000000000/a.pdf' }] });
    expect(signedOut.status).toBe(400);
    expect(signedOut.body.error.fields).toEqual({ attachments: 'Log in to attach files' });
    // Uploads need an account, so a visitor can't get one to attach anyway.
    expect(
      (
        await request(testApp())
          .post('/api/v1/uploads/signature')
          .set('Origin', FRONTEND_ORIGIN)
          .send({ purpose: 'SUPPORT_FILE', contentType: 'application/pdf', size: 10 })
      ).status,
    ).toBe(401);

    const host = await createHost();
    const kiri = await createUser();
    const vehicle = await createVehicle(host._id);
    const booking = await createBookingRecord(
      { guestId: kiri._id, hostId: host._id, vehicleId: vehicle._id },
      { status: 'ACTIVE' },
    );
    await ticketFor(kiri._id);
    const kiriAgent = await signIn(kiri.email);
    const kiriFile = await upload(kiriAgent);

    // Someone else can't put Kiri's file on their ticket, or see her ticket.
    const mere = await createUser({ email: 'mere@example.co.nz', firstName: 'Mere' });
    const mereAgent = await signIn(mere.email);
    const stolen = await mereAgent.post('/api/v1/support/tickets').send({
      ...contact,
      name: 'Mere Tester',
      email: mere.email,
      attachments: [kiriFile],
    });
    expect(stolen.body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect((await mereAgent.get('/api/v1/support/tickets/ST-ABC234')).status).toBe(404);
    const mereFile = await upload(mereAgent);
    expect(
      (
        await mereAgent
          .post('/api/v1/support/tickets/ST-ABC234/messages')
          .send({ body: 'Not mine', attachments: [mereFile] })
      ).status,
    ).toBe(404);

    // Kiri's incident evidence is the booking's, not a support file.
    const evidence = await kiriAgent.post('/api/v1/uploads/signature').send({
      purpose: 'INCIDENT_FILE',
      bookingId: booking.ref,
      contentType: 'application/pdf',
      size: 16,
    });
    await kiriAgent
      .put(new URL(evidence.body.url).pathname)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4 receipt'));
    const misused = await kiriAgent
      .post('/api/v1/support/tickets/ST-ABC234/messages')
      .send({ body: 'The receipt', attachments: [{ key: evidence.body.key, name: 'receipt.pdf' }] });
    expect(misused.body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect((await SupportTicketModel.findOne({ ref: 'ST-ABC234' }).lean())!.messages).toHaveLength(1);
  });

  it('lets staff attach files to a reply and to an internal note, which the member never sees', async () => {
    const kiri = await createUser();
    await ticketFor(kiri._id);
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();

    // Staff attach only what they uploaded themselves.
    const kiriAgent = await signIn(kiri.email);
    const kiriFile = await upload(kiriAgent);
    const notTheirs = await staff
      .post('/api/v1/admin/support/tickets/ST-ABC234/messages')
      .send({ body: 'Your file', attachments: [kiriFile] });
    expect(notTheirs.body.error.code).toBe('UPLOAD_NOT_FOUND');

    const checkIn = await upload(staff, { name: 'check-in.png', contentType: 'image/png' });
    const note = await staff.post('/api/v1/admin/support/tickets/ST-ABC234/messages').send({
      body: 'Host’s photo from check-in.',
      internal: true,
      attachments: [checkIn],
    });
    expect(note.status).toBe(200);
    const map = await upload(staff, { name: 'map.pdf' });
    const reply = await staff.post('/api/v1/admin/support/tickets/ST-ABC234/messages').send({
      body: 'Here’s the pickup map.',
      attachments: [map],
    });
    expect(reply.status).toBe(200);
    expect(
      reply.body.ticket.thread.map((message: { internal: boolean; attachments: { name: string }[] }) => [
        message.internal,
        message.attachments.map((file) => file.name),
      ]),
    ).toEqual([
      [false, []],
      [true, ['check-in.png']],
      [false, ['map.pdf']],
    ]);

    const own = (await kiriAgent.get('/api/v1/support/tickets/ST-ABC234')).body.ticket;
    expect(own.messages.map((message: { body: string }) => message.body)).toEqual([
      'Is it at the airport?',
      'Here’s the pickup map.',
    ]);
    expect(own.messages[1].attachments).toEqual([
      expect.objectContaining({ name: 'map.pdf', url: expect.stringContaining('/files/private/support/') }),
    ]);
    // The email says where to find the file.
    const email = await NotificationModel.findOne({ type: 'SUPPORT_REPLY', channel: 'EMAIL' }).lean();
    expect(email!.payload).toMatchObject({
      props: { paragraphs: expect.arrayContaining(['They added a file: open your request to see it.']) },
    });
  });

  it('keeps files off a reply to someone with no account to see them in', async () => {
    await ticketFor(undefined, { ref: 'ST-VIS123' });
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    const file = await upload(staff);

    const reply = await staff
      .post('/api/v1/admin/support/tickets/ST-VIS123/messages')
      .send({ body: 'See the attached.', attachments: [file] });
    expect(reply.status).toBe(400);
    expect(reply.body.error.fields).toHaveProperty('attachments');
    const note = await staff
      .post('/api/v1/admin/support/tickets/ST-VIS123/messages')
      .send({ body: 'Their receipt, from email.', internal: true, attachments: [file] });
    expect(note.status).toBe(200);
  });
});

describe('Support alerts for staff', () => {
  it('alerts the team about new tickets and replies, then only whoever has the ticket', async () => {
    const aroha = await createStaff('aroha@example.co.nz', 'ADMIN');
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    await UserModel.updateOne({ _id: sam._id }, { $set: { firstName: 'Sam' } });
    const staffCount = (filter: Record<string, unknown>) =>
      NotificationModel.countDocuments({ channel: 'IN_APP', ...filter });

    // A visitor's message, from the Contact form.
    const visitor = await request(testApp())
      .post('/api/v1/support/tickets')
      .set('Origin', FRONTEND_ORIGIN)
      .send({ ...contact, name: 'Tama Visitor', email: 'tama@example.co.nz' });
    expect(await staffCount({ type: 'SUPPORT_TICKET' })).toBe(2);
    expect(
      await NotificationModel.findOne({ type: 'SUPPORT_TICKET', userId: sam._id, channel: 'IN_APP' }),
    ).toMatchObject({
      payload: {
        title: `New support ticket ${visitor.body.ref}`,
        body: expect.stringMatching(/^Tama Visitor wrote about “Scratch on the bumper”: The car had/),
        link: `/admin/support/${visitor.body.ref}`,
      },
    });
    expect(
      await NotificationModel.countDocuments({ type: 'SUPPORT_TICKET', channel: 'EMAIL', userId: sam._id }),
    ).toBe(1);

    // A privacy request is a ticket too, and says so.
    const kiri = await createUser();
    const agent = await signIn(kiri.email);
    const privacy = await agent.post('/api/v1/me/privacy-requests').send({ type: 'ACCESS' });
    expect(
      await NotificationModel.findOne({
        type: 'SUPPORT_TICKET',
        userId: sam._id,
        'payload.link': `/admin/support/${privacy.body.ref}`,
      }),
    ).toMatchObject({ payload: { title: `New privacy request ${privacy.body.ref}` } });

    // Nobody has the ticket yet: the member's reply goes to the whole team.
    await agent.post(`/api/v1/support/tickets/${privacy.body.ref}/messages`).send({ body: 'Any news?' });
    expect(await staffCount({ type: 'SUPPORT_TICKET_REPLY' })).toBe(2);
    expect(
      await NotificationModel.findOne({ type: 'SUPPORT_TICKET_REPLY', userId: sam._id, channel: 'IN_APP' }),
    ).toMatchObject({
      payload: {
        title: `Kiri Tester replied on ticket ${privacy.body.ref}`,
        body: 'Kiri Tester replied about “Privacy: a copy of my personal information”: Any news?',
      },
    });

    // Sam answers, and has it from then on. Staff aren't alerted about their own replies.
    const samAgent = await staffAgent('sam@example.co.nz');
    await samAgent
      .post(`/api/v1/admin/support/tickets/${privacy.body.ref}/messages`)
      .send({ body: 'We’re putting it together.' });
    await samAgent
      .post(`/api/v1/admin/support/tickets/${privacy.body.ref}/messages`)
      .send({ body: 'Check their ID.', internal: true });
    expect(await staffCount({ type: 'SUPPORT_TICKET_REPLY' })).toBe(2);

    await agent.post(`/api/v1/support/tickets/${privacy.body.ref}/messages`).send({ body: 'Thanks!' });
    expect(await staffCount({ type: 'SUPPORT_TICKET_REPLY', userId: sam._id })).toBe(2);
    expect(await staffCount({ type: 'SUPPORT_TICKET_REPLY', userId: aroha._id })).toBe(1);
    // Like a party's update on a case, only in the staff portal's notifications.
    expect(
      await NotificationModel.countDocuments({
        type: 'SUPPORT_TICKET_REPLY',
        channel: 'EMAIL',
        userId: sam._id,
      }),
    ).toBe(1);
  });
});

describe('Answering a closed account', () => {
  it('emails the address on the ticket once the member’s account is closed', async () => {
    const kiri = await createUser();
    const agent = await signIn(kiri.email);
    const asked = await agent.post('/api/v1/me/privacy-requests').send({ type: 'CLOSE_ACCOUNT' });
    expect(asked.status).toBe(201);
    // As closeAccount() leaves it: anonymised, and nothing more goes to the account.
    await UserModel.updateOne(
      { _id: kiri._id },
      {
        $set: {
          email: `closed-${kiri.id}@closed.rentovroom.invalid`,
          firstName: 'Former',
          lastName: 'member',
          status: 'SUSPENDED',
          closedAt: new Date(),
        },
      },
    );
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const staff = await staffAgent();
    await JobModel.deleteMany({});

    // Files can't go to an account nobody can sign in to.
    const file = await upload(staff);
    const withFile = await staff
      .post(`/api/v1/admin/support/tickets/${asked.body.ref}/messages`)
      .send({ body: 'Done.', attachments: [file] });
    expect(withFile.status).toBe(400);

    const reply = await staff
      .post(`/api/v1/admin/support/tickets/${asked.body.ref}/messages`)
      .send({ body: 'Your account is closed and your details removed.', status: 'RESOLVED' });
    expect(reply.status).toBe(200);
    expect(await NotificationModel.countDocuments({ type: 'SUPPORT_REPLY' })).toBe(0);
    const email = await JobModel.findOne({ type: 'email.send' }).lean();
    expect(email!.payload).toMatchObject({
      to: 'kiri@example.co.nz',
      template: 'tripNotice',
      props: {
        firstName: 'Kiri',
        heading: `A reply to your support request ${asked.body.ref}`,
        buttonLabel: 'Contact us',
        note: `To reply, use the contact form and mention ${asked.body.ref}.`,
      },
    });
  });
});

describe('Handing support work on', () => {
  it('hands a ticket to another team member or to nobody, never to someone it is about', async () => {
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    const mere = await createStaff('mere@example.co.nz', 'SUPPORT');
    const kiri = await createUser();
    const kiriAgent = await signIn(kiri.email);
    const { body } = await kiriAgent.post('/api/v1/me/privacy-requests').send({ type: 'ACCESS' });
    const samAgent = await staffAgent('sam@example.co.nz');
    const path = `/api/v1/admin/support/tickets/${body.ref}`;

    const taken = await samAgent.patch(path).send({ assignToMe: true });
    expect(taken.body.ticket).toMatchObject({ assignedToId: sam.id });

    const handed = await samAgent.patch(path).send({ assignTo: mere.id });
    expect(handed.status).toBe(200);
    expect(handed.body.ticket).toMatchObject({ assignedToId: mere.id });
    expect(
      await NotificationModel.findOne({
        type: 'SUPPORT_TICKET_ASSIGNED',
        userId: mere._id,
        channel: 'IN_APP',
      }),
    ).toMatchObject({ payload: { title: `Support request ${body.ref} is assigned to you` } });

    const notStaff = await samAgent.patch(path).send({ assignTo: kiri.id });
    expect(notStaff.status).toBe(409);
    expect(notStaff.body.error.code).toBe('NOT_STAFF');

    // Mere is a Guest too, and asks for her own information: it can't be handed to her.
    const own = await SupportTicketModel.create({
      ref: 'ST-MERE01',
      userId: mere._id,
      subject: 'Privacy: a copy of my personal information',
      category: 'PRIVACY',
      messages: [{ authorId: mere._id, body: 'Please send it' }],
    });
    const toHerself = await samAgent
      .patch(`/api/v1/admin/support/tickets/${own.ref}`)
      .send({ assignTo: mere.id });
    expect(toHerself.status).toBe(409);
    expect(toHerself.body.error.code).toBe('OWN_RECORD');

    const nobody = await samAgent.patch(path).send({ assignTo: null });
    expect(nobody.body.ticket.assignedToId).toBeUndefined();
    expect((await SupportTicketModel.findOne({ ref: body.ref }).lean())!.assignedTo).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'ticket.updated', entityId: body.ref })).toBe(3);
  });

  it('gives a removed team member’s open tickets and cases back to the team', async () => {
    const aroha = await createStaff('aroha@example.co.nz', 'ADMIN');
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    const kiri = await createUser();
    const kiriAgent = await signIn(kiri.email);
    const { body } = await kiriAgent.post('/api/v1/me/privacy-requests').send({ type: 'ACCESS' });
    await SupportTicketModel.updateOne({ ref: body.ref }, { $set: { assignedTo: sam._id } });
    const host = await createHost();
    const vehicle = await createVehicle(host._id);
    const booking = await createBookingRecord({
      guestId: kiri._id,
      hostId: host._id,
      vehicleId: vehicle._id,
    });
    const incident = await IncidentModel.create({
      caseRef: 'IN-SAM777',
      bookingId: booking._id,
      reporterId: kiri._id,
      type: 'DAMAGE',
      description: 'A scratch on the bumper',
      assignedTo: sam._id,
      events: [{ actorId: kiri._id, action: 'OPENED', visibility: 'BOTH', createdAt: new Date() }],
    });

    const admin = await staffAgent();
    expect((await admin.delete(`/api/v1/admin/staff/${sam.id}`)).status).toBe(204);
    expect((await SupportTicketModel.findOne({ ref: body.ref }).lean())!.assignedTo).toBeUndefined();
    const released = (await IncidentModel.findById(incident._id).lean())!;
    expect(released.assignedTo).toBeUndefined();
    expect(released.events.at(-1)).toMatchObject({ action: 'UNASSIGNED', visibility: 'INTERNAL' });
    expect(await AuditLogModel.findOne({ action: 'staff.remove' }).lean()).toMatchObject({
      after: { unassigned: { tickets: 1, incidents: 1 } },
    });

    // A ticket or case still naming someone no longer on the team: the whole team hears of a reply.
    await SupportTicketModel.updateOne({ ref: body.ref }, { $set: { assignedTo: sam._id } });
    await IncidentModel.updateOne({ _id: incident._id }, { $set: { assignedTo: sam._id } });
    await kiriAgent.post(`/api/v1/support/tickets/${body.ref}/messages`).send({ body: 'Any news?' });
    expect(
      await NotificationModel.exists({ type: 'SUPPORT_TICKET_REPLY', userId: aroha._id, channel: 'IN_APP' }),
    ).toBeTruthy();
    expect(await NotificationModel.exists({ type: 'SUPPORT_TICKET_REPLY', userId: sam._id })).toBeNull();
    await kiriAgent.post(`/api/v1/incidents/${incident.caseRef}/events`).send({ note: 'Here is a photo' });
    expect(
      await NotificationModel.exists({ type: 'INCIDENT_UPDATE', userId: aroha._id, channel: 'IN_APP' }),
    ).toBeTruthy();
    expect(await NotificationModel.exists({ type: 'INCIDENT_UPDATE', userId: sam._id })).toBeNull();
  });

  it('gives a suspended team member’s open tickets back to the team', async () => {
    await createStaff('aroha@example.co.nz', 'ADMIN');
    const sam = await createStaff('sam@example.co.nz', 'SUPPORT');
    const kiri = await createUser();
    const { body } = await (
      await signIn(kiri.email)
    )
      .post('/api/v1/me/privacy-requests')
      .send({ type: 'ACCESS' });
    await SupportTicketModel.updateOne({ ref: body.ref }, { $set: { assignedTo: sam._id } });
    const admin = await staffAgent();
    const suspended = await admin.post(`/api/v1/admin/users/${sam.id}/suspend`).send({ reason: 'On leave' });
    expect(suspended.status).toBe(200);
    expect((await SupportTicketModel.findOne({ ref: body.ref }).lean())!.assignedTo).toBeUndefined();
    expect(await AuditLogModel.findOne({ action: 'user.suspended' }).lean()).toMatchObject({
      after: { unassigned: { tickets: 1, incidents: 0 } },
    });
  });
});
