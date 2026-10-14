import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_PHOTO_WIDTHS } from '../src/integrations/storage/images.js';
import { createS3Storage } from '../src/integrations/storage/storage.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { createBookingRecord, createHost, createVehicle } from './fixtures.js';
import { PASSWORD, browserAgent, createStaff, createUser, staffAgent, testApp } from './helpers.js';

type Agent = ReturnType<typeof browserAgent>;

async function signIn(email: string) {
  const agent = browserAgent();
  expect((await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  return agent;
}

/** A small JPEG, as a phone might send. */
const jpeg = () =>
  sharp({ create: { width: 600, height: 450, channels: 3, background: '#2050c0' } })
    .jpeg()
    .toBuffer();

/** Uploads a profile photo through the local driver, as the website does, and returns its key. */
async function uploadPhoto(agent: Agent): Promise<string> {
  const body = await jpeg();
  const target = await agent
    .post('/api/v1/uploads/signature')
    .send({ purpose: 'PROFILE_PHOTO', contentType: 'image/jpeg', size: body.length });
  expect(target.status).toBe(200);
  const sent = await agent
    .put(new URL(target.body.url).pathname)
    .set('Content-Type', 'image/jpeg')
    .send(body);
  expect(sent.status).toBe(201);
  return target.body.key as string;
}

/** Opens a public photo signed out, as anyone's browser would. */
const openPhoto = (url: string) => request(testApp()).get(new URL(url).pathname);

async function trip() {
  const guest = await createUser();
  const host = await createHost();
  const vehicle = await createVehicle(host._id);
  const booking = await createBookingRecord({ guestId: guest._id, hostId: host._id, vehicleId: vehicle._id });
  return { guest, host, booking };
}

describe('Profile photos (spec §8, plan §6.2)', () => {
  it('sets a member’s photo, which the other party sees on the booking and on their profile', async () => {
    const { guest, host, booking } = await trip();
    const agent = await signIn(guest.email);

    const key = await uploadPhoto(agent);
    expect(key).toMatch(new RegExp(`^members/${guest.id}/photo/[0-9a-f-]{36}\\.jpg$`));
    const set = await agent.put('/api/v1/me/photo').send({ key });
    expect(set.status).toBe(200);
    const url = set.body.user.avatarUrl as string;
    expect(url).toMatch(new RegExp(`/api/v1/files/members/${guest.id}/photo/[0-9a-f-]{36}\\.jpg$`));

    expect((await agent.get('/api/v1/me')).body.user.avatarUrl).toBe(url);
    const photo = await openPhoto(url);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');

    const hostAgent = await signIn(host.email);
    const hostView = await hostAgent.get(`/api/v1/bookings/${booking.ref}`);
    expect(hostView.body.booking.guest).toMatchObject({ firstName: 'Kiri', avatarUrl: url });
    // Their public profile, open to visitors like the listing that links to it.
    const profile = await request(testApp()).get(`/api/v1/users/${guest.id}/reviews`);
    expect(profile.body.profile.avatarUrl).toBe(url);
  });

  it('takes only photos the member uploaded as their own profile photo', async () => {
    const kiri = await createUser();
    const mere = await createUser({ email: 'mere@example.co.nz', firstName: 'Mere' });
    const agent = await signIn(kiri.email);

    const pdf = await agent
      .post('/api/v1/uploads/signature')
      .send({ purpose: 'PROFILE_PHOTO', contentType: 'application/pdf', size: 100 });
    expect(pdf.status).toBe(400);
    expect(pdf.body.error.fields).toEqual({ contentType: 'Photos can be JPEG, PNG, WebP or HEIC' });

    const theirs = await uploadPhoto(await signIn(mere.email));
    const support = await agent
      .post('/api/v1/uploads/signature')
      .send({ purpose: 'SUPPORT_FILE', contentType: 'image/jpeg', size: 100 });
    for (const key of [
      theirs,
      // Their own upload, but for a support ticket: private, and not a profile photo.
      support.body.key as string,
      `members/${kiri.id}/photo/../../${mere.id}/photo/${theirs.split('/').at(-1)}`,
      `members/${kiri.id}/photo/${randomUUID()}.jpg`,
    ]) {
      const refused = await agent.put('/api/v1/me/photo').send({ key });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('UPLOAD_NOT_FOUND');
    }
    const empty = await agent.put('/api/v1/me/photo').send({});
    expect(empty.body.error.fields).toEqual({ key: 'Upload a photo first' });

    expect((await UserModel.findById(kiri._id).lean())!.avatarUrl).toBeUndefined();
    expect((await request(testApp()).put('/api/v1/me/photo').send({ key: theirs })).status).toBe(401);
  });

  it('replaces and removes the photo, deleting the files it no longer uses', async () => {
    const kiri = await createUser();
    const agent = await signIn(kiri.email);

    const firstKey = await uploadPhoto(agent);
    const first = (await agent.put('/api/v1/me/photo').send({ key: firstKey })).body.user.avatarUrl as string;
    const secondKey = await uploadPhoto(agent);
    const second = (await agent.put('/api/v1/me/photo').send({ key: secondKey })).body.user
      .avatarUrl as string;
    expect(second).not.toBe(first);
    expect((await openPhoto(first)).status).toBe(404);
    expect((await openPhoto(second)).status).toBe(200);

    const removed = await agent.delete('/api/v1/me/photo');
    expect(removed.status).toBe(200);
    expect(removed.body.user).not.toHaveProperty('avatarUrl');
    expect((await agent.get('/api/v1/me')).body.user).not.toHaveProperty('avatarUrl');
    expect((await openPhoto(second)).status).toBe(404);
    // Removing it again is fine.
    expect((await agent.delete('/api/v1/me/photo')).status).toBe(200);
  });

  it('stops a suspended member changing their photo, and hides their profile', async () => {
    const kiri = await createUser();
    const agent = await signIn(kiri.email);
    const key = await uploadPhoto(agent);
    await UserModel.updateOne({ _id: kiri._id }, { $set: { status: 'SUSPENDED' } });

    expect((await agent.put('/api/v1/me/photo').send({ key })).status).toBe(401);
    expect((await agent.delete('/api/v1/me/photo')).status).toBe(401);
    expect((await request(testApp()).get(`/api/v1/users/${kiri.id}/reviews`)).status).toBe(404);
  });

  it('deletes the photo when the account is closed', async () => {
    const kiri = await createUser();
    const agent = await signIn(kiri.email);
    const key = await uploadPhoto(agent);
    const url = (await agent.put('/api/v1/me/photo').send({ key })).body.user.avatarUrl as string;
    await createStaff();
    const staff = await staffAgent();

    expect((await staff.post(`/api/v1/admin/users/${kiri.id}/close`)).status).toBe(200);
    expect((await UserModel.findById(kiri._id).lean())!.avatarUrl).toBeUndefined();
    expect((await openPhoto(url)).status).toBe(404);
    expect((await request(testApp()).get(`/api/v1/users/${kiri.id}/reviews`)).status).toBe(404);
  });
});

describe('Profile photos in S3', () => {
  /** An S3 driver whose bucket is a Map, so it runs without AWS. */
  function fakeS3() {
    const objects = new Map<string, Buffer>();
    const client = new S3Client({
      region: 'ap-southeast-2',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
    });
    vi.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
      const input = (command as { input: { Key: string; Body?: Buffer } }).input;
      if (command instanceof PutObjectCommand) objects.set(input.Key, input.Body!);
      else if (command instanceof GetObjectCommand) {
        const body = objects.get(input.Key);
        if (!body) throw new NoSuchKey({ message: 'No such key', $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      } else if (command instanceof DeleteObjectCommand) objects.delete(input.Key);
      else throw new Error('Unexpected S3 command');
      return {};
    }) as never);
    const storage = createS3Storage({
      bucket: 'rv-media-test',
      region: 'ap-southeast-2',
      publicUrl: 'https://media.example.com',
      client,
    });
    return { objects, storage };
  }

  it('stores one small WebP copy, and deletes it by its URL', async () => {
    const { objects, storage } = fakeS3();
    const folder = 'members/64f000000000000000000001/photo';
    const id = randomUUID();
    objects.set(`incoming/${folder}/${id}.jpg`, await jpeg());

    const url = await storage.confirmUpload({
      folder,
      isPrivate: false,
      ref: `incoming/${folder}/${id}.jpg`,
      widths: PROFILE_PHOTO_WIDTHS,
    });
    expect(url).toBe(`https://media.example.com/${folder}/${id}-400.webp`);
    expect([...objects.keys()]).toEqual([`public/${folder}/${id}-400.webp`]);
    expect(await sharp(objects.get(`public/${folder}/${id}-400.webp`)!).metadata()).toMatchObject({
      format: 'webp',
      width: 400,
      height: 300,
    });

    // Someone else's URL is left alone.
    await storage.deletePublic({ url: `https://elsewhere.example.com/${folder}/${id}-400.webp` });
    expect(objects.size).toBe(1);
    await storage.deletePublic({ url, widths: PROFILE_PHOTO_WIDTHS });
    expect(objects.size).toBe(0);
  });
});
