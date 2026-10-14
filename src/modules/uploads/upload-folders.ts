import { MESSAGE_PREVIEW_WIDTH } from '../../integrations/storage/images.js';
import { logger } from '../../integrations/logger.js';
import { deletePrivateFile, getStorage, fileLink } from '../../integrations/storage/storage.js';
import { HttpError } from '../../lib/http-error.js';
import type { FileAttachment } from '../../lib/model-fields.js';
import type {
  AttachmentInput,
  AttachmentView,
  BookingUploadPurpose,
  UploadPurpose,
} from './uploads.schemas.js';

const BOOKING_FOLDERS: Record<BookingUploadPurpose, string> = {
  MESSAGE_PHOTO: 'messages',
  INSPECTION_PHOTO: 'inspections',
  INCIDENT_FILE: 'incidents',
};

/** The folder of a car's files; documents are private (plan §3, public and private files). */
export function uploadFolder(purpose: UploadPurpose, vehicleId: string) {
  return purpose === 'VEHICLE_PHOTO'
    ? { folder: `vehicles/${vehicleId}/photos`, isPrivate: false }
    : { folder: `vehicles/${vehicleId}/documents`, isPrivate: true };
}

/** The folder of a booking's files: message photos, inspection photos and incident evidence, all private. */
export function bookingUploadFolder(purpose: BookingUploadPurpose, bookingId: string) {
  return { folder: `bookings/${bookingId}/${BOOKING_FOLDERS[purpose]}`, isPrivate: true };
}

/**
 * The folder of a member's support ticket files, private (plan §3, public and private files). It's their
 * own, so a ticket only takes files its author uploaded.
 */
export function supportUploadFolder(userId: string) {
  return { folder: `support/${userId}`, isPrivate: true };
}

/**
 * The folder of a member's profile photo, public like listing photos (plan §6.2: the other party sees it).
 * It's their own, so nobody can set a photo someone else uploaded.
 */
export function profilePhotoFolder(userId: string) {
  return { folder: `members/${userId}/photo`, isPrivate: false };
}

/** Checks each uploaded file belongs to the booking's folder, and turns it into what's saved. */
export async function confirmBookingFiles(
  purpose: BookingUploadPurpose,
  bookingId: string,
  files: AttachmentInput[],
): Promise<FileAttachment[]> {
  return confirmFiles(bookingUploadFolder(purpose, bookingId), files, {
    sharedPhotos: purpose === 'MESSAGE_PHOTO',
  });
}

/** Checks each file is one this member uploaded for a support ticket, and turns it into what's saved. */
export async function confirmSupportFiles(
  userId: string,
  files: AttachmentInput[],
): Promise<FileAttachment[]> {
  return confirmFiles(supportUploadFolder(userId), files);
}

/** Refuses the same upload twice in one request: each key is one file, attached once. */
export function refuseRepeatedKeys(keys: string[], field: string) {
  if (new Set(keys).size !== keys.length) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      [field]: 'The same file is in there twice. Remove one, or upload it again.',
    });
  }
}

/** Deletes saved private files, e.g. ones attached for a record that then couldn't be saved. */
export async function discardFiles(stored: string[]): Promise<void> {
  await Promise.all(
    stored.map((url) =>
      deletePrivateFile(url).catch((error: unknown) =>
        logger.warn({ err: error }, 'Could not delete a file that was attached to nothing'),
      ),
    ),
  );
}

/**
 * Attaches each upload with `confirm`. If one can't be, those already attached are deleted again (their keys
 * no longer work), so nothing is left that no record points to; the person uploads them again.
 */
export async function confirmEach<Input, Saved>(
  inputs: Input[],
  confirm: (input: Input) => Promise<Saved>,
  filesOf: (saved: Saved) => string[],
): Promise<Saved[]> {
  const results = await Promise.allSettled(inputs.map(confirm));
  const failed = results.find((result) => result.status === 'rejected');
  if (!failed) return results.map((result) => (result as PromiseFulfilledResult<Saved>).value);
  await discardFiles(
    results.flatMap((result) => (result.status === 'fulfilled' ? filesOf(result.value) : [])),
  );
  throw failed.reason;
}

/** What a saved file keeps in storage: the file, and a message photo's smaller copy. */
export const attachmentFiles = (file: FileAttachment) => [
  file.url,
  ...(file.previewUrl ? [file.previewUrl] : []),
];

async function confirmFiles(
  { folder, isPrivate }: { folder: string; isPrivate: boolean },
  files: AttachmentInput[],
  options: { sharedPhotos?: boolean } = {},
): Promise<FileAttachment[]> {
  refuseRepeatedKeys(
    files.map((file) => file.key),
    'attachments',
  );
  return confirmEach(
    files,
    async (file): Promise<FileAttachment> => {
      const extra = {
        ...(file.name && { name: file.name }),
        ...(file.contentType && { contentType: file.contentType }),
      };
      if (!options.sharedPhotos) {
        return { url: await getStorage().confirmUpload({ folder, isPrivate, ref: file.key }), ...extra };
      }
      // The other party sees it: stored without where it was taken, with a copy for the conversation.
      const { url, previewUrl } = await getStorage().confirmSharedPhoto({
        folder,
        ref: file.key,
        previewWidth: MESSAGE_PREVIEW_WIDTH,
      });
      return { url, previewUrl, ...extra, contentType: 'image/jpeg' };
    },
    attachmentFiles,
  );
}

/** A saved file as its viewer gets it: a private file's link works for at least 10 minutes. */
export function attachmentView(file: FileAttachment): AttachmentView {
  return {
    url: fileLink(file.url),
    ...(file.previewUrl && { previewUrl: fileLink(file.previewUrl) }),
    ...(file.name && { name: file.name }),
    ...(file.contentType && { contentType: file.contentType }),
  };
}
