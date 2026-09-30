import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import type { DocumentType, PhotoType, Vehicle } from './vehicle.model.js';

/*
 * The missing-items check before a listing is submitted (plan §9, Days 8–11): required details,
 * documents and photo angles come from platformSettings. Anything here blocks submitting. Flags don't:
 * they're shown to support staff in the review queue.
 */

export interface ChecklistItem {
  /** The onboarding step it belongs to, 1–6. */
  step: number;
  field: string;
  message: string;
}

export interface ChecklistFlag {
  code: 'LOW_QUALITY_PHOTO' | 'DAMAGE_WITHOUT_PHOTO' | 'MISSING_RECOMMENDED_PHOTO';
  message: string;
}

export interface Checklist {
  complete: boolean;
  missing: ChecklistItem[];
  flags: ChecklistFlag[];
}

export const PHOTO_ANGLE_NAMES: Record<PhotoType, string> = {
  FRONT: 'front',
  REAR: 'rear',
  DRIVER: 'driver side',
  PASSENGER: 'passenger side',
  INTERIOR: 'interior',
  DASH: 'dashboard and odometer',
  BOOT: 'boot',
  TYRES: 'tyres',
  DAMAGE: 'existing damage',
};

const DOCUMENT_NAMES: Record<DocumentType, string> = {
  REGO: 'registration',
  WOF: 'WOF',
  COF: 'CoF',
  RUC: 'Road User Charges licence',
  INSURANCE: 'insurance',
  OWNER_CONSENT: "registered owner's consent",
  OTHER: 'other document',
};

/** Diesel, EV and plug-in hybrid cars pay Road User Charges (plan §3). */
export const needsRuc = (fuelType?: string) =>
  fuelType === 'DIESEL' || fuelType === 'EV' || fuelType === 'PHEV';

type ChecklistVehicle = Pick<
  Vehicle,
  | 'regoPlate'
  | 'vin'
  | 'chassisNo'
  | 'make'
  | 'model'
  | 'year'
  | 'bodyType'
  | 'fuelType'
  | 'transmission'
  | 'seats'
  | 'doors'
  | 'regoExpiry'
  | 'wofExpiry'
  | 'cofExpiry'
  | 'rucValidToKm'
  | 'ownerIsHost'
  | 'photos'
  | 'documents'
  | 'pricing'
  | 'kmAllowancePerDay'
  | 'unlimitedKm'
  | 'deliveryOptions'
  | 'damageNotes'
>;

export function listingChecklist(
  vehicle: ChecklistVehicle,
  settings: PlatformSettings,
  now = new Date(),
): Checklist {
  const missing: ChecklistItem[] = [];
  const need = (step: number, field: string, message: string) => missing.push({ step, field, message });
  const rules = settings.vehicles;

  // Step 1: vehicle details.
  if (!vehicle.regoPlate) need(1, 'regoPlate', 'Add the number plate');
  if (rules.vinOrChassisRequired && !vehicle.vin && !vehicle.chassisNo) {
    need(1, 'vin', 'Add the VIN, or the chassis number for an import without one');
  }
  if (!vehicle.make) need(1, 'make', 'Add the make');
  if (!vehicle.model) need(1, 'model', 'Add the model');
  if (!vehicle.year) need(1, 'year', 'Add the year');
  if (!vehicle.bodyType) need(1, 'bodyType', 'Choose the body type');
  if (!vehicle.fuelType) need(1, 'fuelType', 'Choose the fuel type');
  if (!vehicle.transmission) need(1, 'transmission', 'Choose the transmission');
  if (!vehicle.seats) need(1, 'seats', 'Add the number of seats');
  if (!vehicle.doors) need(1, 'doors', 'Add the number of doors');

  // Step 2: documents and their dates. A rejected document counts as missing.
  if (!vehicle.regoExpiry || vehicle.regoExpiry <= now)
    need(2, 'regoExpiry', 'Add a registration expiry date in the future');
  const inspection = vehicle.cofExpiry ?? vehicle.wofExpiry;
  if (!inspection || inspection <= now) need(2, 'wofExpiry', 'Add a WOF (or CoF) expiry date in the future');
  if (needsRuc(vehicle.fuelType) && vehicle.rucValidToKm === undefined) {
    need(2, 'rucValidToKm', 'Add the odometer reading your Road User Charges licence runs to');
  }
  const hasDocument = (type: DocumentType) =>
    vehicle.documents.some((document) => document.type === type && document.status !== 'REJECTED');
  for (const type of rules.requiredDocuments) {
    // A CoF counts as the WOF for vehicles that need one (plan §3).
    const satisfied = hasDocument(type) || (type === 'WOF' && hasDocument('COF'));
    if (!satisfied) need(2, `documents.${type}`, `Upload the ${DOCUMENT_NAMES[type]}`);
  }
  if (!vehicle.ownerIsHost && !hasDocument('OWNER_CONSENT')) {
    need(2, 'documents.OWNER_CONSENT', "Upload the registered owner's written consent");
  }

  // Step 3: the required photo angles. A photo support rejected is flagged back to the Host as missing.
  const hasPhoto = (type: PhotoType) =>
    vehicle.photos.some((photo) => photo.type === type && photo.status !== 'REJECTED');
  for (const angle of rules.requiredPhotoAngles) {
    if (!hasPhoto(angle)) need(3, `photos.${angle}`, `Add a photo of the ${PHOTO_ANGLE_NAMES[angle]}`);
  }

  // Step 4: pricing.
  const daily = vehicle.pricing?.dailyCents;
  if (!daily) need(4, 'pricing.dailyCents', 'Set a daily price');
  if (!vehicle.unlimitedKm && !vehicle.kmAllowancePerDay) {
    need(4, 'kmAllowancePerDay', 'Set a daily kilometre allowance, or offer unlimited kilometres');
  }

  // Step 6: where guests collect the car.
  const pickup = vehicle.deliveryOptions.find((option) => option.type === 'PICKUP');
  if (!pickup?.address) need(6, 'deliveryOptions.PICKUP', 'Add the address where guests collect the car');

  const flags: ChecklistFlag[] = [];
  for (const photo of vehicle.photos) {
    if (photo.status !== 'REJECTED' && photo.qualityFlag !== 'OK') {
      flags.push({
        code: 'LOW_QUALITY_PHOTO',
        message: `The ${PHOTO_ANGLE_NAMES[photo.type]} photo may be ${
          photo.qualityFlag === 'LOW_RES'
            ? 'too small'
            : photo.qualityFlag === 'DARK'
              ? 'too dark'
              : photo.qualityFlag === 'BLURRY'
                ? 'blurry'
                : 'unsuitable'
        }`,
      });
    }
  }
  if (vehicle.damageNotes && !hasPhoto('DAMAGE')) {
    flags.push({
      code: 'DAMAGE_WITHOUT_PHOTO',
      message: 'Existing damage is declared but there is no damage photo',
    });
  }

  return { complete: missing.length === 0, missing, flags };
}
