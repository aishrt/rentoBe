import type { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { NotificationModel } from '../src/modules/notifications/notification.model.js';
import {
  notificationCountsSchema,
  notificationsDeletedSchema,
  notificationsResponseSchema,
} from '../src/modules/notifications/notifications.schemas.js';
import { notify } from '../src/modules/notifications/notify.js';
import { PASSWORD, browserAgent, createUser, testApp } from './helpers.js';

type Agent = ReturnType<typeof browserAgent>;

const MINUTE = 60_000;
const NOW = Date.now();

async function signIn(email: string): Promise<Agent> {
  const agent = browserAgent();
  const response = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  return agent;
}

interface Seed {
  title: string;
  minutesAgo: number;
  read?: boolean;
  deleted?: boolean;
  channel?: 'IN_APP' | 'EMAIL';
}

/** Notifications for one user, as notify() writes them, at the given ages. Returns their ids by title. */
async function seed(userId: Types.ObjectId, seeds: Seed[]) {
  const docs = await NotificationModel.insertMany(
    seeds.map(({ title, minutesAgo, read, deleted, channel = 'IN_APP' }) => {
      const at = new Date(NOW - minutesAgo * MINUTE);
      return {
        userId,
        type: 'BOOKING_CONFIRMED',
        channel,
        status: 'SENT',
        payload: { title, link: '/trips/RV-7K2Q9M' },
        createdAt: at,
        ...(read && { readAt: at }),
        ...(deleted && { deletedAt: at }),
      };
    }),
  );
  return Object.fromEntries(docs.map((doc, index) => [seeds[index]!.title, doc.id as string]));
}

/** Kiri's five notifications (two of them read, and two at the same moment), plus ones she must never see. */
async function kiriAndHana() {
  const kiri = await createUser();
  const hana = await createUser({ email: 'hana@example.co.nz', firstName: 'Hana' });
  const ids = await seed(kiri._id, [
    { title: 'One', minutesAgo: 1 },
    { title: 'Two', minutesAgo: 2, read: true },
    { title: 'Three', minutesAgo: 3 },
    { title: 'Four', minutesAgo: 3, read: true },
    { title: 'Five', minutesAgo: 5 },
    { title: 'Deleted', minutesAgo: 0, deleted: true },
    { title: 'Her email', minutesAgo: 0, channel: 'EMAIL' },
  ]);
  const hanas = await seed(hana._id, [
    { title: 'Hana unread', minutesAgo: 0 },
    { title: 'Hana read', minutesAgo: 0, read: true },
  ]);
  return { kiri, hana, ids, hanas, agent: await signIn('kiri@example.co.nz') };
}

const list = async (agent: Agent, query = '') => {
  const response = await agent.get(`/api/v1/notifications${query}`);
  expect(response.status).toBe(200);
  return notificationsResponseSchema.parse(response.body);
};

const titles = (page: { notifications: { title: string }[] }) => page.notifications.map((item) => item.title);

describe('GET /notifications', () => {
  it('lists the user’s own in-app notifications, newest first, a page at a time', async () => {
    const { agent } = await kiriAndHana();

    const all = await list(agent);
    // Three and Four arrived at the same moment: the later id goes first.
    expect(titles(all)).toEqual(['One', 'Two', 'Four', 'Three', 'Five']);
    expect(all).toMatchObject({ unreadCount: 3, total: 5 });
    expect(all.nextCursor).toBeUndefined();
    expect(all.notifications[0]).toMatchObject({ title: 'One', read: false, link: '/trips/RV-7K2Q9M' });

    // Two at a time, with a page break between Four and Three: neither is skipped or repeated.
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await list(
        agent,
        `?limit=${pages.length === 0 ? 3 : 2}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page).toMatchObject({ unreadCount: 3, total: 5 });
      pages.push(titles(page));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual([
      ['One', 'Two', 'Four'],
      ['Three', 'Five'],
    ]);
  });

  it('lists only unread ones on request, still with both counts', async () => {
    const { agent } = await kiriAndHana();

    const first = await list(agent, '?unread=true&limit=2');
    expect(titles(first)).toEqual(['One', 'Three']);
    expect(first).toMatchObject({ unreadCount: 3, total: 5 });

    const second = await list(agent, `?unread=true&limit=2&cursor=${first.nextCursor}`);
    expect(titles(second)).toEqual(['Five']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('refuses a page size or cursor it can’t use, and visitors', async () => {
    const { agent } = await kiriAndHana();

    for (const query of ['?limit=0', '?limit=51', '?limit=many']) {
      const response = await agent.get(`/api/v1/notifications${query}`);
      expect(response.status).toBe(400);
      expect(response.body.error.fields).toHaveProperty('limit');
    }
    const cursor = await agent.get('/api/v1/notifications?cursor=not-a-cursor');
    expect(cursor.status).toBe(400);
    expect(cursor.body.error.fields).toHaveProperty('cursor');

    expect((await list(agent, '?limit=50')).notifications).toHaveLength(5);
    expect((await request(testApp()).get('/api/v1/notifications')).status).toBe(401);
  });
});

describe('Marking read and unread', () => {
  it('marks some or all read, and some unread again, only ever the user’s own', async () => {
    const { agent, ids, hanas } = await kiriAndHana();

    const one = await agent.post('/api/v1/notifications/read').send({ ids: [ids.One, hanas['Hana unread']] });
    expect(notificationCountsSchema.parse(one.body)).toEqual({ unreadCount: 2, total: 5 });

    const unread = await agent
      .post('/api/v1/notifications/unread')
      .send({ ids: [ids.One, ids.Two, hanas['Hana read'], ids.Deleted] });
    expect(notificationCountsSchema.parse(unread.body)).toEqual({ unreadCount: 4, total: 5 });
    expect(titles(await list(agent, '?unread=true'))).toEqual(['One', 'Two', 'Three', 'Five']);

    const all = await agent.post('/api/v1/notifications/read').send({});
    expect(all.body).toEqual({ unreadCount: 0, total: 5 });

    // Hana's are as they were.
    expect(await NotificationModel.findById(hanas['Hana unread']).lean()).not.toHaveProperty('readAt');
    expect(await NotificationModel.findById(hanas['Hana read']).lean()).toHaveProperty('readAt');
  });

  it('needs at least one id to mark unread, and no more than 100', async () => {
    const { agent, ids } = await kiriAndHana();

    expect((await agent.post('/api/v1/notifications/unread').send({})).status).toBe(400);
    expect((await agent.post('/api/v1/notifications/unread').send({ ids: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => ids.One);
    expect((await agent.post('/api/v1/notifications/unread').send({ ids: tooMany })).status).toBe(400);
    expect((await agent.post('/api/v1/notifications/read').send({ ids: tooMany })).status).toBe(400);
  });
});

describe('Deleting', () => {
  it('deletes one, and treats someone else’s as not found', async () => {
    const { agent, ids, hanas } = await kiriAndHana();

    expect((await agent.delete(`/api/v1/notifications/${hanas['Hana unread']}`)).status).toBe(404);
    expect((await agent.delete('/api/v1/notifications/not-an-id')).status).toBe(404);
    expect(await NotificationModel.findById(hanas['Hana unread']).lean()).not.toHaveProperty('deletedAt');

    expect((await agent.delete(`/api/v1/notifications/${ids.One}`)).status).toBe(204);
    // Deleting it again is fine.
    expect((await agent.delete(`/api/v1/notifications/${ids.One}`)).status).toBe(204);

    const after = await list(agent);
    expect(titles(after)).not.toContain('One');
    expect(after).toMatchObject({ unreadCount: 2, total: 4 });
  });

  it('deletes some by id, or every read one, never anyone else’s', async () => {
    const { agent, ids, hana, hanas } = await kiriAndHana();

    const some = await agent
      .post('/api/v1/notifications/delete')
      .send({ ids: [ids.Three, hanas['Hana read'], hanas['Hana unread']] });
    expect(notificationsDeletedSchema.parse(some.body)).toEqual({ deleted: 1, unreadCount: 2, total: 4 });

    const read = await agent.post('/api/v1/notifications/delete').send({ read: true });
    expect(read.body).toEqual({ deleted: 2, unreadCount: 2, total: 2 });
    expect(titles(await list(agent))).toEqual(['One', 'Five']);

    // Marking everything read leaves the deleted ones alone.
    await agent.post('/api/v1/notifications/read').send({});
    expect(await NotificationModel.findById(ids.Three).lean()).not.toHaveProperty('readAt');

    // Hana's are all still there.
    for (const item of await NotificationModel.find({ userId: hana._id }).lean()) {
      expect(item).not.toHaveProperty('deletedAt');
    }
    expect((await agent.post('/api/v1/notifications/delete').send({})).status).toBe(400);
    expect((await agent.post('/api/v1/notifications/delete').send({ read: false })).status).toBe(400);
  });

  it('keeps a deleted notification away when the job behind it runs again', async () => {
    const kiri = await createUser();
    const agent = await signIn('kiri@example.co.nz');
    const event = {
      userId: kiri._id,
      type: 'LISTING_APPROVED',
      title: 'Your car is live',
      dedupeKey: 'LISTING_APPROVED:1',
    };

    await notify(event);
    const [item] = (await list(agent)).notifications;
    expect((await agent.delete(`/api/v1/notifications/${item!.id}`)).status).toBe(204);

    await notify(event);
    expect(await list(agent)).toMatchObject({ notifications: [], total: 0, unreadCount: 0 });
    expect(await NotificationModel.countDocuments({ dedupeKey: 'LISTING_APPROVED:1' })).toBe(1);
  });
});

describe('notification preferences', () => {
  it('saves the choices, and the unsubscribe link turns marketing off without signing in', async () => {
    const { unsubscribeToken } = await import('../src/modules/users/notification-prefs.js');
    const user = await createUser();
    const agent = browserAgent();
    await agent.post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });

    expect((await agent.get('/api/v1/me/notification-prefs')).body.prefs).toEqual({
      marketingEmail: false,
      marketingSms: false,
      unreadMessageSms: false,
      unreadMessageEmail: true,
    });
    const changed = await agent
      .patch('/api/v1/me/notification-prefs')
      .send({ marketingEmail: true, marketingSms: true, unreadMessageSms: true });
    expect(changed.body.prefs).toEqual({
      marketingEmail: true,
      marketingSms: true,
      unreadMessageSms: true,
      unreadMessageEmail: true,
    });

    const visitor = browserAgent();
    expect(
      (await visitor.post('/api/v1/notifications/unsubscribe').send({ token: `${user.id}.forged-signature` }))
        .status,
    ).toBe(400);
    expect(
      (await visitor.post('/api/v1/notifications/unsubscribe').send({ token: unsubscribeToken(user.id) }))
        .status,
    ).toBe(200);
    expect((await agent.get('/api/v1/me/notification-prefs')).body.prefs).toEqual({
      marketingEmail: false,
      marketingSms: false,
      unreadMessageSms: true,
      unreadMessageEmail: true,
    });
  });
});
