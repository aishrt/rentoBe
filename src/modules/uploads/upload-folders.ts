import { getStorage, fileLink } from '../../integrations/storage/storage.js';
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

/** Checks each uploaded file belongs to the booking's folder, and turns it into what's saved. */
export async function confirmBookingFiles(
  purpose: BookingUploadPurpose,
  bookingId: string,
  files: AttachmentInput[],
): Promise<FileAttachment[]> {
  return confirmFiles(bookingUploadFolder(purpose, bookingId), files);
}

/** Checks each file is one this member uploaded for a support ticket, and turns it into what's saved. */
export async function confirmSupportFiles(
  userId: string,
  files: AttachmentInput[],
): Promise<FileAttachment[]> {
  return confirmFiles(supportUploadFolder(userId), files);
}

async function confirmFiles(
  { folder, isPrivate }: { folder: string; isPrivate: boolean },
  files: AttachmentInput[],
): Promise<FileAttachment[]> {
  return Promise.all(
    files.map(async (file) => ({
      url: await getStorage().confirmUpload({ folder, isPrivate, ref: file.key }),
      ...(file.name && { name: file.name }),
      ...(file.contentType && { contentType: file.contentType }),
    })),
  );
}

/** A saved file as its viewer gets it: a private file's link expires after 10 minutes. */
export function attachmentView(file: FileAttachment): AttachmentView {
  return {
    url: fileLink(file.url),
    ...(file.name && { name: file.name }),
    ...(file.contentType && { contentType: file.contentType }),
  };
}
