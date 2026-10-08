import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, relative } from 'node:path';
import express, { Router, type Response } from 'express';
import mongoose from 'mongoose';
import { localFilePath, localUploadRoot } from '../../integrations/storage/local-files.js';
import {
  MAX_UPLOAD_BYTES,
  getStorage,
  readUploadToken,
  verifyPrivateLink,
} from '../../integrations/storage/storage.js';
import { HttpError, forbidden } from '../../lib/http-error.js';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { findBookingFor } from '../bookings/booking.service.js';
import { isStaff } from '../users/user.service.js';
import { VehicleModel } from '../vehicles/vehicle.model.js';
import {
  BOOKING_UPLOAD_PURPOSES,
  DOCUMENT_TYPES_ALLOWED,
  PHOTO_TYPES_ALLOWED,
  uploadRequestSchema,
  type BookingUploadPurpose,
  type UploadPurpose,
} from './uploads.schemas.js';
import { bookingUploadFolder, uploadFolder } from './upload-folders.js';

/** Purposes that take photos only; documents and incident evidence can also be a PDF. */
const PHOTO_PURPOSES: UploadPurpose[] = ['VEHICLE_PHOTO', 'MESSAGE_PHOTO', 'INSPECTION_PHOTO'];

const isBookingPurpose = (purpose: UploadPurpose): purpose is BookingUploadPurpose =>
  (BOOKING_UPLOAD_PURPOSES as readonly string[]).includes(purpose);

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
};

async function sendLocalFile(res: Response, key: string, cacheControl: string) {
  let path: string;
  try {
    path = localFilePath(key);
    await stat(path);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'No such file.');
  }
  res
    .set('Cache-Control', cacheControl)
    // The website shows these images from another port or subdomain of the same site.
    .set('Cross-Origin-Resource-Policy', 'same-site')
    .type(CONTENT_TYPES[extname(key)] ?? 'application/octet-stream')
    // Relative to the folder: Express refuses any path through a dot-folder, such as the default .uploads.
    .sendFile(relative(localUploadRoot(), path), { root: localUploadRoot() });
}

/** Mounted at /api/v1/uploads. */
export function uploadsRouter() {
  const router = Router();

  // A signed upload target for one file (plan §11: POST /uploads/signature).
  router.post('/signature', requireAuth, async (req, res) => {
    const input = validate(uploadRequestSchema, req.body);
    const photosOnly = PHOTO_PURPOSES.includes(input.purpose);
    const allowed: readonly string[] = photosOnly ? PHOTO_TYPES_ALLOWED : DOCUMENT_TYPES_ALLOWED;
    if (!allowed.includes(input.contentType)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
        contentType: photosOnly ? 'Photos can be JPEG, PNG, WebP or HEIC' : 'Files can be a PDF or a photo',
      });
    }

    let target: { folder: string; isPrivate: boolean };
    if (isBookingPurpose(input.purpose)) {
      // Only the booking's Guest and Host, or support staff, add files to it.
      const { booking } = await findBookingFor(
        { userId: req.auth!.userId, roles: req.auth!.roles },
        input.bookingId!,
      );
      target = bookingUploadFolder(input.purpose, booking.id);
    } else {
      const vehicle = await VehicleModel.findById(input.vehicleId).select('hostId').lean();
      if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'No car with that id.');
      if (!vehicle.hostId.equals(req.auth!.userId) && !isStaff(req.auth!.roles)) throw forbidden();
      target = uploadFolder(input.purpose, input.vehicleId!);
    }

    const { folder, isPrivate } = target;
    res.json(
      await getStorage().createUpload({
        folder,
        isPrivate,
        contentType: input.contentType,
        userId: req.auth!.userId,
      }),
    );
  });

  // The local driver's upload (development only): the file is the request body.
  router.put(
    '/local/:token',
    requireAuth,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const token = readUploadToken(String(req.params.token));
      if (!token || token.userId !== req.auth!.userId) {
        throw new HttpError(403, 'UPLOAD_EXPIRED', 'This upload link has expired. Please try again.');
      }
      if (
        req.get('content-type') !== token.contentType ||
        !Buffer.isBuffer(req.body) ||
        req.body.length === 0
      ) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'The file is empty or not the expected type.');
      }
      const path = localFilePath(token.key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, req.body);
      res.status(201).json({ key: token.key });
    },
  );

  return router;
}

/**
 * Mounted at /api/v1/files: the signed links to private documents (either driver), and the files the
 * local driver keeps (development only).
 */
export function filesRouter() {
  const router = Router();

  // Private documents open only through a signed link that expires. In S3, the file itself is behind a
  // one-minute S3 link made when the signed link is opened.
  router.get('/private/*key', async (req, res) => {
    const key = (req.params.key as unknown as string[]).join('/');
    const { e, s } = req.query;
    if (typeof e !== 'string' || typeof s !== 'string' || !verifyPrivateLink(key, e, s)) {
      throw new HttpError(403, 'LINK_EXPIRED', 'This link has expired. Open the document again.');
    }
    const download = await getStorage().downloadUrl(key);
    if (download) {
      res.set('Cache-Control', 'private, no-store').redirect(302, download);
      return;
    }
    await sendLocalFile(res, key, 'private, no-store');
  });

  // Listing photos are public once uploaded; documents never are.
  router.get('/*key', async (req, res) => {
    const key = (req.params.key as unknown as string[]).join('/');
    if (!/^vehicles\/[0-9a-f]{24}\/photos\//.test(key) || !mongoose.isValidObjectId(key.split('/')[1])) {
      throw new HttpError(404, 'NOT_FOUND', 'No such file.');
    }
    await sendLocalFile(res, key, 'public, max-age=31536000, immutable');
  });

  return router;
}
