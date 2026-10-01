import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { isHeif } from '../src/integrations/storage/images.js';
import { createS3Storage, fileLink, verifyPrivateLink } from '../src/integrations/storage/storage.js';

const VEHICLE = 'vehicles/64f000000000000000000001';
const PHOTOS = `${VEHICLE}/photos`;
const DOCUMENTS = `${VEHICLE}/documents`;
const MAX_BYTES = 15 * 1024 * 1024;

/** 320×240, red on the left half and blue on the right, saved as HEIC. */
const heic = () => readFile(new URL('./files/red-blue.heic', import.meta.url));

interface Stored {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
}

/** An S3 driver whose bucket is a Map, so it runs without AWS. Signing works offline with test keys. */
function fakeS3() {
  const objects = new Map<string, Stored>();
  const client = new S3Client({
    region: 'ap-southeast-2',
    credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret' },
  });
  vi.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
    const input = (
      command as { input: { Key: string; Body?: Buffer; ContentType?: string; CacheControl?: string } }
    ).input;
    const object = objects.get(input.Key);
    if (command instanceof PutObjectCommand) {
      objects.set(input.Key, {
        body: input.Body!,
        contentType: input.ContentType!,
        cacheControl: input.CacheControl!,
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      if (!object) throw new NoSuchKey({ message: 'No such key', $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
    }
    if (command instanceof HeadObjectCommand) {
      if (!object) throw new NotFound({ message: 'Not Found', $metadata: { httpStatusCode: 404 } });
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(input.Key);
      return {};
    }
    throw new Error('Unexpected S3 command');
  }) as never);
  const storage = createS3Storage({
    bucket: 'rv-media-test',
    region: 'ap-southeast-2',
    publicUrl: 'https://media.example.com/',
    client,
  });
  return { objects, storage };
}

const target = (storage: ReturnType<typeof fakeS3>['storage'], isPrivate: boolean, contentType: string) =>
  storage.createUpload({ folder: isPrivate ? DOCUMENTS : PHOTOS, isPrivate, contentType, userId: 'u1' });

describe('S3 uploads', () => {
  it('signs a POST that fixes the key, the type and the size limit', async () => {
    const { storage } = fakeS3();
    const photo = await target(storage, false, 'image/jpeg');
    expect(photo).toMatchObject({
      driver: 's3',
      method: 'POST',
      url: 'https://rv-media-test.s3.ap-southeast-2.amazonaws.com/',
      maxBytes: MAX_BYTES,
    });
    expect(photo.key).toMatch(new RegExp(`^incoming/${PHOTOS}/[0-9a-f-]{36}\\.jpg$`));
    expect(photo.fields).toMatchObject({ key: photo.key, 'Content-Type': 'image/jpeg' });
    const policy = JSON.parse(Buffer.from(photo.fields!.Policy!, 'base64').toString('utf8')) as {
      conditions: unknown[];
    };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ['content-length-range', 1, MAX_BYTES],
        ['eq', '$Content-Type', 'image/jpeg'],
        { key: photo.key },
      ]),
    );

    const document = await target(storage, true, 'application/pdf');
    expect(document.key).toMatch(new RegExp(`^private/${DOCUMENTS}/[0-9a-f-]{36}\\.pdf$`));
  });

  it('stores upright WebP copies of a photo, without its metadata, and drops the original', async () => {
    const { objects, storage } = fakeS3();
    const upload = await target(storage, false, 'image/jpeg');
    // 2400×1600 taken with the phone on its side: EXIF orientation 6 turns it to 1600×2400.
    const jpeg = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#2050c0' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    objects.set(upload.key, { body: jpeg });

    const url = await storage.confirmUpload({ folder: PHOTOS, isPrivate: false, ref: upload.key });
    const id = upload.key.split('/').at(-1)!.replace('.jpg', '');
    expect(url).toBe(`https://media.example.com/${PHOTOS}/${id}-1600.webp`);
    expect(objects.has(upload.key)).toBe(false);

    for (const [width, size] of [
      [800, { width: 533, height: 800 }],
      [1600, { width: 1067, height: 1600 }],
    ] as const) {
      const stored = objects.get(`public/${PHOTOS}/${id}-${width}.webp`)!;
      expect(stored).toMatchObject({
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      const metadata = await sharp(stored.body).metadata();
      expect(metadata).toMatchObject({ format: 'webp', ...size });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
    }
  });

  it('decodes HEIC photos, and leaves small photos their own size', async () => {
    const { objects, storage } = fakeS3();
    const file = await heic();
    expect(isHeif(file)).toBe(true);
    const upload = await target(storage, false, 'image/heic');
    objects.set(upload.key, { body: file });

    await storage.confirmUpload({ folder: PHOTOS, isPrivate: false, ref: upload.key });
    const id = upload.key.split('/').at(-1)!.replace('.heic', '');
    const { data, info } = await sharp(objects.get(`public/${PHOTOS}/${id}-800.webp`)!.body)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 320, height: 240, channels: 3 });
    const pixel = (x: number, y: number) => [...data.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    const [r1, , b1] = pixel(40, 120);
    const [r2, , b2] = pixel(280, 120);
    expect(r1).toBeGreaterThan(150);
    expect(b1).toBeLessThan(100);
    expect(b2).toBeGreaterThan(150);
    expect(r2).toBeLessThan(100);
  });

  it("refuses keys it didn't hand out, files that never arrived, and photos it can't read", async () => {
    const { objects, storage } = fakeS3();
    const confirm = (ref: string, isPrivate = false) =>
      storage.confirmUpload({ folder: isPrivate ? DOCUMENTS : PHOTOS, isPrivate, ref });
    const elsewhere = `incoming/vehicles/64f000000000000000000002/photos/${randomUUID()}.jpg`;
    for (const ref of [
      elsewhere,
      `public/${PHOTOS}/${randomUUID()}-1600.webp`,
      `incoming/${PHOTOS}/../documents/${randomUUID()}.jpg`,
      `incoming/${PHOTOS}/${randomUUID()}.pdf`,
    ]) {
      await expect(confirm(ref)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    }
    await expect(confirm(`incoming/${PHOTOS}/${randomUUID()}.jpg`, true)).rejects.toMatchObject({
      code: 'UPLOAD_NOT_FOUND',
    });

    const neverSent = await target(storage, false, 'image/jpeg');
    await expect(confirm(neverSent.key)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    const missingDocument = await target(storage, true, 'application/pdf');
    await expect(confirm(missingDocument.key, true)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });

    const notAPhoto = await target(storage, false, 'image/jpeg');
    objects.set(notAPhoto.key, { body: Buffer.from('not a photo') });
    await expect(confirm(notAPhoto.key)).rejects.toMatchObject({ status: 400, code: 'UNREADABLE_IMAGE' });
  });

  it('keeps documents private, turns HEIC into JPEG, and opens them through the API', async () => {
    const { objects, storage } = fakeS3();
    const pdf = await target(storage, true, 'application/pdf');
    objects.set(pdf.key, { body: Buffer.from('%PDF-1.4 test') });
    const stored = await storage.confirmUpload({ folder: DOCUMENTS, isPrivate: true, ref: pdf.key });
    const path = pdf.key.slice('private/'.length);
    expect(stored).toBe(`s3:${path}`);

    const link = new URL(fileLink(stored));
    expect(link.pathname).toBe(`/api/v1/files/private/${path}`);
    expect(verifyPrivateLink(path, link.searchParams.get('e')!, link.searchParams.get('s')!)).toBe(true);
    const download = new URL((await storage.downloadUrl(path))!);
    expect(download.host).toBe('rv-media-test.s3.ap-southeast-2.amazonaws.com');
    expect(download.pathname).toBe(`/${pdf.key}`);
    expect(download.searchParams.get('X-Amz-Expires')).toBe('60');

    const photo = await target(storage, true, 'image/heic');
    objects.set(photo.key, { body: await heic() });
    const jpeg = await storage.confirmUpload({ folder: DOCUMENTS, isPrivate: true, ref: photo.key });
    expect(jpeg).toBe(`s3:${photo.key.slice('private/'.length).replace('.heic', '.jpg')}`);
    const converted = objects.get(`private/${jpeg.slice('s3:'.length)}`)!;
    expect(converted.contentType).toBe('image/jpeg');
    expect(await sharp(converted.body).metadata()).toMatchObject({ format: 'jpeg', width: 320, height: 240 });
    expect(objects.has(photo.key)).toBe(false);
  });
});
