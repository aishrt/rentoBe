import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, isProduction } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { PHOTO_WIDTHS, documentAsJpeg, photoVariants, sharedPhoto } from './images.js';
import { localFilePath } from './local-files.js';

/*
 * Vehicle photos and documents (plan §1.2, §3 "Public and private files"). Browsers upload straight
 * to storage with a short-lived signed target from the API, so large files never pass through it
 * (the API's WAF also refuses bodies over 8 KB). Photos are public; documents are private and only
 * reachable through short-lived signed links for the Host and support staff.
 *
 * - `s3`: signed direct uploads (a presigned POST) to the S3 bucket in Sydney. A listing photo lands in
 *   `incoming/`; attaching it stores WebP copies in `public/`, which CloudFront serves at
 *   MEDIA_PUBLIC_URL. A private file (a document, or a booking's or support ticket's file) lands in
 *   `incoming/private/`, which nobody can read, and attaching it moves it to `private/`. Their links lead
 *   through this API, which checks the link and redirects to a short-lived S3 link.
 * - `local`: files in UPLOAD_DIR, served by this API. Development only.
 *
 * A private upload is attached once: attaching moves it out of `incoming/private/`, so its key can't be
 * sent again (as the check-out's photos, say). The bucket's rule for `incoming/` deletes whatever is never
 * attached (a retaken photo, an abandoned inspection) after a day.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
/** How long a link to a private document works, at least. */
export const PRIVATE_LINK_TTL_SECONDS = 10 * 60;
/**
 * Private links are made in 10-minute steps, so a page refreshed meanwhile gets the same link for the same
 * file, and the browser shows the copy it has rather than downloading it again.
 */
const LINK_STEP_SECONDS = 10 * 60;
/** Where a private upload waits until it's attached. Nothing reads it there, and S3 deletes it after a day. */
const PRIVATE_INCOMING = 'incoming/private';

export interface UploadTarget {
  driver: 'local' | 's3';
  method: 'PUT' | 'POST';
  url: string;
  /** PUT: headers to send with the file as the body. */
  headers?: Record<string, string>;
  /** POST: form fields to send with the file, in a multipart form with the file as `file`. */
  fields?: Record<string, string>;
  /** What to attach to the car once the file is sent. */
  key: string;
  maxBytes: number;
}

export interface StorageDriver {
  readonly driver: 'local' | 's3';
  /** Where the browser sends one file for `folder`, e.g. "vehicles/<id>/photos". */
  createUpload(input: {
    folder: string;
    isPrivate: boolean;
    contentType: string;
    userId: string;
  }): Promise<UploadTarget>;
  /**
   * Turns an upload's key into the value saved on the record: a public URL, or a private reference
   * (`local:` or `s3:`, then the file's path). Refuses a file outside `folder`, and a private one already
   * attached: it moves out of `incoming/private/`, so its key works once. A public photo is stored in
   * `widths` (a listing photo's PHOTO_WIDTHS unless given), and the URL is the widest copy.
   */
  confirmUpload(input: {
    folder: string;
    isPrivate: boolean;
    ref: string;
    widths?: readonly number[];
  }): Promise<string>;
  /**
   * A private photo the other party sees, such as a message photo: stored upright as a JPEG without its
   * metadata, which can say where it was taken (plan §6.2), with a smaller WebP copy for the conversation.
   * Its key works once, as with confirmUpload.
   */
  confirmSharedPhoto(input: {
    folder: string;
    ref: string;
    previewWidth: number;
  }): Promise<{ url: string; previewUrl: string }>;
  /**
   * Where a private file is fetched from: an S3 link that works for `ttlSeconds` (a minute at least) and
   * lets the browser keep the file that long, or null when this API serves it.
   */
  downloadUrl(path: string, ttlSeconds?: number): Promise<string | null>;
  /** Deletes a private file past its retention period (plan §14). A file already gone is fine. */
  deletePrivate(path: string): Promise<void>;
  /**
   * Deletes a public photo, by the URL confirmUpload gave it and the widths it was stored in, e.g. a profile
   * photo replaced or removed. A URL this driver didn't make, or a file already gone, is left alone.
   */
  deletePublic(input: { url: string; widths?: readonly number[] }): Promise<void>;
}

const unavailable = () =>
  new HttpError(
    503,
    'UPLOADS_UNAVAILABLE',
    "Photo and document uploads aren't available yet. Please try again later.",
  );
const notOurs = () =>
  new HttpError(400, 'UPLOAD_NOT_FOUND', "We couldn't find that upload. Please upload the file again.");

const signingKey = () => createHash('sha256').update(`uploads:${env.ENCRYPTION_KEY}`).digest();
const hmac = (value: string) => createHmac('sha256', signingKey()).update(value).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
};

export interface LocalUploadToken {
  key: string;
  contentType: string;
  userId: string;
  expiresAt: number;
}

/** A signed, expiring permission to PUT one file to one key (local driver). */
export function signUploadToken(token: LocalUploadToken): string {
  const payload = Buffer.from(JSON.stringify(token)).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function readUploadToken(token: string, now = Date.now()): LocalUploadToken | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, hmac(payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalUploadToken;
    return parsed.expiresAt > now ? parsed : null;
  } catch {
    return null;
  }
}

/** Checks a private file link's signature and expiry. */
export function verifyPrivateLink(
  path: string,
  expires: string,
  signature: string,
  now = Date.now(),
): boolean {
  const expiresAt = Number(expires) * 1000;
  return (
    Number.isFinite(expiresAt) && expiresAt > now && safeEqual(signature, hmac(`file:${path}:${expires}`))
  );
}

const apiBase = () => env.API_PUBLIC_URL.replace(/\/+$/, '');

/** A saved file value that needs a signed link to open (a document), rather than a public URL. */
export const isPrivateRef = (stored: string) => stored.startsWith('local:') || stored.startsWith('s3:');

/**
 * A link to a private file through this API (either driver). It works for `ttlSeconds` to `ttlSeconds` plus
 * 10 minutes: it ends on a 10-minute step, so it stays the same between refreshes (LINK_STEP_SECONDS).
 */
export function privateLink(stored: string, ttlSeconds = PRIVATE_LINK_TTL_SECONDS, now = Date.now()): string {
  const path = stored.replace(/^(local|s3):/, '');
  const step = Math.ceil(now / 1000 / LINK_STEP_SECONDS) * LINK_STEP_SECONDS;
  const expires = String(step + ttlSeconds);
  return `${apiBase()}/api/v1/files/private/${path}?e=${expires}&s=${hmac(`file:${path}:${expires}`)}`;
}

/** How many seconds a private link with this expiry (its `e`) still works. */
export function linkSecondsLeft(expires: string, now = Date.now()): number {
  return Math.max(0, Number(expires) - Math.floor(now / 1000));
}

/** The file names both drivers hand out: a UUID and the type's extension. */
const FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$/;

/** The file name in a key handed out for `folder` under `prefix`, or null for any other key. */
function nameIn(prefix: string, folder: string, ref: string) {
  const start = `${prefix}/${folder}/`;
  const name = ref.startsWith(start) ? ref.slice(start.length) : '';
  return FILE_NAME.test(name) ? name : null;
}

/** Where a shared photo (confirmSharedPhoto) and its smaller copy are kept, by the upload's file name. */
function sharedPhotoPaths(folder: string, name: string, previewWidth: number) {
  const id = name.slice(0, name.indexOf('.'));
  return { path: `${folder}/${id}.jpg`, previewPath: `${folder}/${id}-${previewWidth}.webp` };
}

export function createLocalStorage(): StorageDriver {
  return {
    driver: 'local',

    async createUpload({ folder, isPrivate, contentType, userId }) {
      if (isProduction) throw unavailable();
      const key = `${isPrivate ? `${PRIVATE_INCOMING}/` : ''}${folder}/${randomUUID()}${EXTENSIONS[contentType] ?? ''}`;
      const token = signUploadToken({
        key,
        contentType,
        userId,
        expiresAt: Date.now() + UPLOAD_TTL_SECONDS * 1000,
      });
      return {
        driver: 'local',
        method: 'PUT',
        url: `${apiBase()}/api/v1/uploads/local/${token}`,
        headers: { 'Content-Type': contentType },
        key,
        maxBytes: MAX_UPLOAD_BYTES,
      };
    },

    async confirmUpload({ folder, isPrivate, ref }) {
      if (isPrivate) {
        const name = nameIn(PRIVATE_INCOMING, folder, ref);
        if (!name) throw notOurs();
        const path = `${folder}/${name}`;
        await mkdir(dirname(localFilePath(path)), { recursive: true });
        try {
          // Attaching the same upload again finds nothing left to move.
          await rename(localFilePath(ref), localFilePath(path));
        } catch {
          throw notOurs();
        }
        return `local:${path}`;
      }
      if (!ref.startsWith(`${folder}/`) || ref.includes('..')) throw notOurs();
      try {
        await stat(localFilePath(ref));
      } catch {
        throw notOurs();
      }
      return `${apiBase()}/api/v1/files/${ref}`;
    },

    async confirmSharedPhoto({ folder, ref, previewWidth }) {
      const name = nameIn(PRIVATE_INCOMING, folder, ref);
      if (!name || name.endsWith('.pdf')) throw notOurs();
      let original: Buffer;
      try {
        original = await readFile(localFilePath(ref));
      } catch {
        throw notOurs();
      }
      const { photo, preview } = await sharedPhoto(original, previewWidth);
      const { path, previewPath } = sharedPhotoPaths(folder, name, previewWidth);
      await mkdir(dirname(localFilePath(path)), { recursive: true });
      try {
        // Only if it isn't there yet: the same upload attached twice at once is refused the second time.
        await writeFile(localFilePath(path), photo, { flag: 'wx' });
      } catch (error) {
        throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? notOurs() : error;
      }
      await writeFile(localFilePath(previewPath), preview);
      await unlink(localFilePath(ref)).catch(() => undefined);
      return { url: `local:${path}`, previewUrl: `local:${previewPath}` };
    },

    async downloadUrl() {
      return null;
    },

    async deletePrivate(path) {
      await unlink(localFilePath(path)).catch(() => undefined);
    },

    async deletePublic({ url }) {
      const start = `${apiBase()}/api/v1/files/`;
      const ref = url.startsWith(start) ? url.slice(start.length) : '';
      if (!ref || ref.includes('..')) return;
      try {
        await unlink(localFilePath(ref));
      } catch {
        // Already gone, or not a file this driver keeps.
      }
    },
  };
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PRIVATE_FILE = 'private, no-store';
/** How long the S3 link that a private file's link redirects to works, at least. */
const DOWNLOAD_TTL_SECONDS = 60;

export function createS3Storage(config: {
  bucket: string;
  region: string;
  /** Where CloudFront serves the bucket's `public/` folder, e.g. https://media.rentovroom.com. */
  publicUrl: string;
  /** Credentials come from the ECS task role in production, and the usual AWS settings elsewhere. */
  client?: S3Client;
}): StorageDriver {
  const { bucket } = config;
  const client = config.client ?? new S3Client({ region: config.region });
  const publicUrl = config.publicUrl.replace(/\/+$/, '');

  // A key that was never uploaded answers 404, or 403 to a role that can't list the bucket. One already
  // attached answers 404 too (it has moved), or 412 when its new place is taken (409 while it's being taken).
  const missingAsNotOurs = (error: unknown) =>
    error instanceof S3ServiceException && [403, 404, 409, 412].includes(error.$metadata.httpStatusCode ?? 0)
      ? notOurs()
      : error;

  async function read(key: string): Promise<Buffer> {
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await object.Body!.transformToByteArray());
    } catch (error) {
      throw missingAsNotOurs(error);
    }
  }

  /** Stores a file; with `once`, only if nothing is there yet, so the same upload can't be attached twice. */
  async function put(key: string, body: Buffer, contentType: string, cacheControl: string, once = false) {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          ...(once && { IfNoneMatch: '*' }),
        }),
      );
    } catch (error) {
      throw once ? missingAsNotOurs(error) : error;
    }
  }
  const remove = (key: string) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

  /** Moves an upload to where it's kept, once: a second move finds it gone, or its new place taken. */
  async function move(from: string, to: string) {
    try {
      await client.send(
        new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/${from}`, Key: to, IfNoneMatch: '*' }),
      );
    } catch (error) {
      throw missingAsNotOurs(error);
    }
    await remove(from);
  }

  return {
    driver: 's3',

    async createUpload({ folder, isPrivate, contentType }) {
      const key = `${isPrivate ? PRIVATE_INCOMING : 'incoming'}/${folder}/${randomUUID()}${EXTENSIONS[contentType] ?? ''}`;
      const { url, fields } = await createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 1, MAX_UPLOAD_BYTES],
          ['eq', '$Content-Type', contentType],
        ],
        Fields: { 'Content-Type': contentType },
        Expires: UPLOAD_TTL_SECONDS,
      });
      return { driver: 's3', method: 'POST', url, fields, key, maxBytes: MAX_UPLOAD_BYTES };
    },

    async confirmUpload({ folder, isPrivate, ref, widths = PHOTO_WIDTHS }) {
      if (isPrivate) {
        const name = nameIn(PRIVATE_INCOMING, folder, ref);
        if (!name) throw notOurs();
        if (!/\.hei[cf]$/.test(name)) {
          await move(ref, `private/${folder}/${name}`);
          return `s3:${folder}/${name}`;
        }
        // Support staff open documents in any browser, and only Safari shows HEIC.
        const jpeg = `${folder}/${name.replace(/\.hei[cf]$/, '.jpg')}`;
        await put(`private/${jpeg}`, await documentAsJpeg(await read(ref)), 'image/jpeg', PRIVATE_FILE, true);
        await remove(ref);
        return `s3:${jpeg}`;
      }

      const name = nameIn('incoming', folder, ref);
      if (!name || name.endsWith('.pdf')) throw notOurs();
      const id = name.slice(0, name.indexOf('.'));
      const variants = await photoVariants(await read(ref), widths);
      await Promise.all(
        variants.map(({ width, body }) =>
          put(`public/${folder}/${id}-${width}.webp`, body, 'image/webp', IMMUTABLE),
        ),
      );
      await remove(ref);
      return `${publicUrl}/${folder}/${id}-${Math.max(...widths)}.webp`;
    },

    async confirmSharedPhoto({ folder, ref, previewWidth }) {
      const name = nameIn(PRIVATE_INCOMING, folder, ref);
      if (!name || name.endsWith('.pdf')) throw notOurs();
      const { photo, preview } = await sharedPhoto(await read(ref), previewWidth);
      const { path, previewPath } = sharedPhotoPaths(folder, name, previewWidth);
      await put(`private/${path}`, photo, 'image/jpeg', PRIVATE_FILE, true);
      await put(`private/${previewPath}`, preview, 'image/webp', PRIVATE_FILE);
      await remove(ref);
      return { url: `s3:${path}`, previewUrl: `s3:${previewPath}` };
    },

    async deletePrivate(path) {
      await remove(`private/${path}`);
    },

    async deletePublic({ url, widths = PHOTO_WIDTHS }) {
      // The URL is the widest copy, `<folder>/<uuid>-<width>.webp`; every width shares the rest.
      const path = url.startsWith(`${publicUrl}/`) ? url.slice(publicUrl.length + 1) : '';
      const base = /^((?:[\w-]+\/)+[0-9a-f-]{36})-\d+\.webp$/.exec(path)?.[1];
      if (!base) return;
      await Promise.all(widths.map((width) => remove(`public/${base}-${width}.webp`)));
    },

    downloadUrl(path, ttlSeconds = DOWNLOAD_TTL_SECONDS) {
      const seconds = Math.max(DOWNLOAD_TTL_SECONDS, Math.floor(ttlSeconds));
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: `private/${path}`,
          // The browser may keep the file while the link works, whatever the file itself says.
          ResponseCacheControl: `private, max-age=${seconds}`,
        }),
        { expiresIn: seconds },
      );
    },
  };
}

let storage: StorageDriver | undefined;

export function getStorage(): StorageDriver {
  storage ??=
    env.UPLOAD_DRIVER === 's3'
      ? createS3Storage({
          bucket: env.S3_BUCKET!,
          region: env.S3_REGION,
          publicUrl: env.MEDIA_PUBLIC_URL!,
        })
      : createLocalStorage();
  return storage;
}

/** The link to show for a saved file: public URLs as they are, private files as a short-lived link. */
export function fileLink(stored: string): string {
  return isPrivateRef(stored) ? privateLink(stored) : stored;
}

/** Deletes a saved private file (a `local:` or `s3:` reference); public URLs are left alone. */
export async function deletePrivateFile(stored: string): Promise<void> {
  if (!isPrivateRef(stored)) return;
  await getStorage().deletePrivate(stored.replace(/^(local|s3):/, ''));
}
