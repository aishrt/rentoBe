import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, isProduction } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { PHOTO_WIDTHS, documentAsJpeg, photoVariants } from './images.js';
import { localFilePath } from './local-files.js';

/*
 * Vehicle photos and documents (plan §1.2, §3 "Public and private files"). Browsers upload straight
 * to storage with a short-lived signed target from the API, so large files never pass through it
 * (the API's WAF also refuses bodies over 8 KB). Photos are public; documents are private and only
 * reachable through short-lived signed links for the Host and support staff.
 *
 * - `s3`: signed direct uploads (a presigned POST) to the S3 bucket in Sydney. A listing photo lands in
 *   `incoming/`; attaching it stores WebP copies in `public/`, which CloudFront serves at
 *   MEDIA_PUBLIC_URL. Documents go to `private/`, and their links lead through this API, which checks
 *   the link and redirects to a one-minute S3 link.
 * - `local`: files in UPLOAD_DIR, served by this API. Development only.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
/** How long a link to a private document works. */
export const PRIVATE_LINK_TTL_SECONDS = 10 * 60;

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
   * (`local:` or `s3:`, then the file's path). Refuses a file outside `folder`.
   */
  confirmUpload(input: { folder: string; isPrivate: boolean; ref: string }): Promise<string>;
  /** Where a private file is fetched from: a short-lived S3 link, or null when this API serves it. */
  downloadUrl(path: string): Promise<string | null>;
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

/** A link to a private file through this API, which stops working after `ttlSeconds` (either driver). */
export function privateLink(stored: string, ttlSeconds = PRIVATE_LINK_TTL_SECONDS): string {
  const path = stored.replace(/^(local|s3):/, '');
  const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  return `${apiBase()}/api/v1/files/private/${path}?e=${expires}&s=${hmac(`file:${path}:${expires}`)}`;
}

export function createLocalStorage(): StorageDriver {
  return {
    driver: 'local',

    async createUpload({ folder, contentType, userId }) {
      if (isProduction) throw unavailable();
      const key = `${folder}/${randomUUID()}${EXTENSIONS[contentType] ?? ''}`;
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
      if (!ref.startsWith(`${folder}/`) || ref.includes('..')) throw notOurs();
      try {
        await stat(localFilePath(ref));
      } catch {
        throw notOurs();
      }
      return isPrivate ? `local:${ref}` : `${apiBase()}/api/v1/files/${ref}`;
    },

    async downloadUrl() {
      return null;
    },
  };
}

/** The file names the S3 driver hands out: a UUID and the type's extension. */
const S3_FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp|heic|heif|pdf)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** How long the S3 link that a private file's link redirects to works. */
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

  /** The file name in a key handed out for `folder` under `prefix`, or null for any other key. */
  const nameIn = (prefix: string, folder: string, ref: string) => {
    const start = `${prefix}/${folder}/`;
    const name = ref.startsWith(start) ? ref.slice(start.length) : '';
    return S3_FILE_NAME.test(name) ? name : null;
  };

  // A key that was never uploaded answers 404, or 403 to a role that can't list the bucket.
  const missingAsNotOurs = (error: unknown) =>
    error instanceof S3ServiceException && [403, 404].includes(error.$metadata.httpStatusCode ?? 0)
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

  const put = (key: string, body: Buffer, contentType: string, cacheControl: string) =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  const remove = (key: string) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

  return {
    driver: 's3',

    async createUpload({ folder, isPrivate, contentType }) {
      const key = `${isPrivate ? 'private' : 'incoming'}/${folder}/${randomUUID()}${EXTENSIONS[contentType] ?? ''}`;
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

    async confirmUpload({ folder, isPrivate, ref }) {
      if (isPrivate) {
        const name = nameIn('private', folder, ref);
        if (!name) throw notOurs();
        if (!/\.hei[cf]$/.test(name)) {
          try {
            await client.send(new HeadObjectCommand({ Bucket: bucket, Key: ref }));
          } catch (error) {
            throw missingAsNotOurs(error);
          }
          return `s3:${folder}/${name}`;
        }
        // Support staff open documents in any browser, and only Safari shows HEIC.
        const jpeg = `${folder}/${name.replace(/\.hei[cf]$/, '.jpg')}`;
        await put(
          `private/${jpeg}`,
          await documentAsJpeg(await read(ref)),
          'image/jpeg',
          'private, no-store',
        );
        await remove(ref);
        return `s3:${jpeg}`;
      }

      const name = nameIn('incoming', folder, ref);
      if (!name || name.endsWith('.pdf')) throw notOurs();
      const id = name.slice(0, name.indexOf('.'));
      const variants = await photoVariants(await read(ref));
      await Promise.all(
        variants.map(({ width, body }) =>
          put(`public/${folder}/${id}-${width}.webp`, body, 'image/webp', IMMUTABLE),
        ),
      );
      await remove(ref);
      return `${publicUrl}/${folder}/${id}-${Math.max(...PHOTO_WIDTHS)}.webp`;
    },

    downloadUrl(path) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: `private/${path}` }), {
        expiresIn: DOWNLOAD_TTL_SECONDS,
      });
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
