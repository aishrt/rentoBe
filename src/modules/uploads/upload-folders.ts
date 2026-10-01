import type { UploadPurpose } from './uploads.schemas.js';

/** The folder each purpose uploads to; documents are private (plan §3, public and private files). */
export function uploadFolder(purpose: UploadPurpose, vehicleId: string) {
  return purpose === 'VEHICLE_PHOTO'
    ? { folder: `vehicles/${vehicleId}/photos`, isPrivate: false }
    : { folder: `vehicles/${vehicleId}/documents`, isPrivate: true };
}
