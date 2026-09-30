import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { env, isProduction } from '../../env.js';
import { HttpError } from '../../lib/http-error.js';
import { localFilePath } from './local-files.js';

/*
 * Vehicle photos and documents (plan §1.2, §3 "Public and private files"). Browsers upload straight
 * to storage with a short-lived signed target from the API, so large files never pass through it
 * (the API's WAF also refuses bodies over 8 KB). Photos are public; documents are private and only
 * reachable through short-lived signed links for the Host and support staff.
 *
 * - `cloudinary`: signed direct uploads to Cloudinary, which also resizes and serves WebP/AVIF from
 *   its CDN. Waiting for the client's account (plan §9, Waiting for the client).
 * - `local`: files in UPLOAD_DIR, served by this API. Development only.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
/** How long a link to a private document works. */
export const PRIVATE_LINK_TTL_SECONDS = 10 * 60;

export interface UploadTarget {
  driver: 'local' | 'cloudinary';
  method: 'PUT' | 'POST';
  url: string;
  /** PUT: headers to send with the file as the body. */
  headers?: Record<string, string>;
  /** POST: form fields to send with the file, in a multipart form with the file as `file`. */
  fields?: Record<string, string>;
  maxBytes: number;
}

export interface StorageDriver {
  readonly driver: 'local' | 'cloudinary';
  /** Where the browser sends one file for `folder`, e.g. "vehicles/<id>/photos". */
  createUpload(input: {
    folder: string;
    isPrivate: boolean;
    contentType: string;
    userId: string;
  }): UploadTarget;
  /**
   * Turns what the browser got back (the local key, or Cloudinary's public_id) into the value saved
   * on the record: a public URL, or a private reference. Refuses a file outside `folder`.
   */
  confirmUpload(input: { folder: string; isPrivate: boolean; ref: string }): Promise<string>;
  /** A link to a private file that stops working after `ttlSeconds`. */
  privateLink(stored: string, ttlSeconds?: number): string;
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

/** Checks a private file link's signature and expiry (local driver). */
export function verifyPrivateLink(
  key: string,
  expires: string,
  signature: string,
  now = Date.now(),
): boolean {
  const expiresAt = Number(expires) * 1000;
  return (
    Number.isFinite(expiresAt) && expiresAt > now && safeEqual(signature, hmac(`file:${key}:${expires}`))
  );
}

const apiBase = () => env.API_PUBLIC_URL.replace(/\/+$/, '');

export function createLocalStorage(): StorageDriver {
  return {
    driver: 'local',

    createUpload({ folder, contentType, userId }) {
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

    privateLink(stored, ttlSeconds = PRIVATE_LINK_TTL_SECONDS) {
      const key = stored.replace(/^local:/, '');
      const expires = String(Math.floor(Date.now() / 1000) + ttlSeconds);
      return `${apiBase()}/api/v1/files/private/${key}?e=${expires}&s=${hmac(`file:${key}:${expires}`)}`;
    },
  };
}

/** Cloudinary's API signature: SHA-1 of the sorted parameters and the API secret. */
export function cloudinarySignature(params: Record<string, string | number>, apiSecret: string): string {
  const signed = Object.keys(params)
    .filter((name) => params[name] !== undefined && params[name] !== '')
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&');
  return createHash('sha1').update(`${signed}${apiSecret}`).digest('hex');
}

export function createCloudinaryStorage(config: {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}): StorageDriver {
  const root = 'rento-vroom';
  const api = `https://api.cloudinary.com/v1_1/${config.cloudName}`;

  return {
    driver: 'cloudinary',

    createUpload({ folder, isPrivate }) {
      const params = {
        folder: `${root}/${folder}`,
        timestamp: Math.floor(Date.now() / 1000),
        type: isPrivate ? 'private' : 'upload',
      };
      return {
        driver: 'cloudinary',
        method: 'POST',
        // Documents may be PDFs; `auto` lets Cloudinary pick the right resource type.
        url: `${api}/${isPrivate ? 'auto' : 'image'}/upload`,
        fields: {
          ...Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)])),
          api_key: config.apiKey,
          signature: cloudinarySignature(params, config.apiSecret),
        },
        maxBytes: MAX_UPLOAD_BYTES,
      };
    },

    async confirmUpload({ folder, isPrivate, ref }) {
      if (!ref.startsWith(`${root}/${folder}/`) || !/^[\w/.-]+$/.test(ref)) throw notOurs();
      return isPrivate
        ? `cloudinary:${ref}`
        : `https://res.cloudinary.com/${config.cloudName}/image/upload/f_auto,q_auto/${ref}`;
    },

    privateLink(stored, ttlSeconds = PRIVATE_LINK_TTL_SECONDS) {
      const now = Math.floor(Date.now() / 1000);
      const params = {
        public_id: stored.replace(/^cloudinary:/, ''),
        timestamp: now,
        type: 'private',
        expires_at: now + ttlSeconds,
      };
      const query = new URLSearchParams({
        ...Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)])),
        api_key: config.apiKey,
        signature: cloudinarySignature(params, config.apiSecret),
      });
      return `${api}/image/download?${query.toString()}`;
    },
  };
}

let storage: StorageDriver | undefined;

export function getStorage(): StorageDriver {
  storage ??=
    env.UPLOAD_DRIVER === 'cloudinary'
      ? createCloudinaryStorage({
          cloudName: env.CLOUDINARY_CLOUD_NAME!,
          apiKey: env.CLOUDINARY_API_KEY!,
          apiSecret: env.CLOUDINARY_API_SECRET!,
        })
      : createLocalStorage();
  return storage;
}

/** A saved file value that needs a signed link to open (a document), rather than a public URL. */
export const isPrivateRef = (stored: string) =>
  stored.startsWith('local:') || stored.startsWith('cloudinary:');

/** The link to show for a saved file: public URLs as they are, private files as a short-lived link. */
export function fileLink(stored: string): string {
  return isPrivateRef(stored) ? getStorage().privateLink(stored) : stored;
}
