import { createHmac } from 'node:crypto';
import { env } from '../../env.js';
import type { Vehicle, VehiclePhoto } from './vehicle.model.js';

/*
 * What the public sees of a listing (plan §3, location and contact privacy): approved photos, the
 * suburb and an approximate area, the rego and WOF status by month. Never the number plate, the
 * exact address or a pending photo.
 */

type Titled = Pick<Vehicle, 'year' | 'make' | 'model'>;

/** "2022 Toyota RAV4". */
export const vehicleTitle = (vehicle: Titled) =>
  [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Untitled car';

const PHOTO_NAMES: Record<VehiclePhoto['type'], string> = {
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

/** The order photos appear in the gallery (spec §6): front first, damage last. */
const GALLERY_ORDER = Object.keys(PHOTO_NAMES) as VehiclePhoto['type'][];

export function publicPhotos(vehicle: Titled & { photos: VehiclePhoto[] }) {
  const title = vehicleTitle(vehicle);
  return vehicle.photos
    .filter((photo) => photo.status === 'APPROVED')
    .sort((a, b) => GALLERY_ORDER.indexOf(a.type) - GALLERY_ORDER.indexOf(b.type) || a.order - b.order)
    .map((photo) => ({
      id: photo._id?.toString() ?? `${photo.type}-${photo.order}`,
      type: photo.type,
      url: photo.url,
      alt: `${title}: ${PHOTO_NAMES[photo.type]}`,
    }));
}

export function coverPhoto(vehicle: Titled & { photos: VehiclePhoto[] }) {
  const [first] = publicPhotos(vehicle);
  return first ? { url: first.url, alt: first.alt } : null;
}

/** Up to three features for a card: the most useful extras first, then the Host's own list. */
export function keyFeatures(
  vehicle: Pick<Vehicle, 'features' | 'petFriendly' | 'childSeat' | 'unlimitedKm'>,
): string[] {
  const extras = [
    vehicle.unlimitedKm && 'Unlimited kilometres',
    vehicle.childSeat && 'Child seat available',
    vehicle.petFriendly && 'Pet friendly',
  ].filter((feature): feature is string => Boolean(feature));
  return [...extras, ...vehicle.features].slice(0, 3);
}

export type ComplianceStatus = 'CURRENT' | 'EXPIRED' | 'NOT_RECORDED';

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

function status(expiry: Date | undefined, now: Date): { status: ComplianceStatus; expiresMonth?: string } {
  if (!expiry) return { status: 'NOT_RECORDED' };
  return { status: expiry > now ? 'CURRENT' : 'EXPIRED', expiresMonth: monthOf(expiry) };
}

/**
 * Registration and WOF (or CoF) status with the expiry month, and whether a Road User Charges
 * licence is recorded for diesel, EV and plug-in hybrid cars (plan §9, Days 8–10). No plate.
 */
export function complianceSummary(
  vehicle: Pick<Vehicle, 'regoExpiry' | 'wofExpiry' | 'cofExpiry' | 'fuelType' | 'rucValidToKm'>,
  now = new Date(),
) {
  const needsRuc = vehicle.fuelType === 'DIESEL' || vehicle.fuelType === 'EV' || vehicle.fuelType === 'PHEV';
  return {
    rego: status(vehicle.regoExpiry, now),
    inspection: {
      kind: vehicle.cofExpiry ? ('COF' as const) : ('WOF' as const),
      ...status(vehicle.cofExpiry ?? vehicle.wofExpiry, now),
    },
    ruc: needsRuc
      ? { required: true, recorded: vehicle.rucValidToKm !== undefined }
      : { required: false, recorded: false },
  };
}

/** How far the map's circle centre may sit from the car, and the circle's radius (plan §3). */
const APPROX_OFFSET_M = 400;
export const APPROX_RADIUS_M = 1_000;
const METRES_PER_DEGREE = 111_320;

/**
 * An area around the car for the listing map (spec §22): the centre moves up to 400 m in a direction
 * fixed for this car, so the 1 km circle always contains the car but never points to its address.
 */
export function approximateArea(id: string, [lng, lat]: [number, number]) {
  const digest = createHmac('sha256', env.ENCRYPTION_KEY).update(`approx:${id}`).digest();
  const angle = (digest.readUInt16BE(0) / 0xffff) * 2 * Math.PI;
  const distance = (0.5 + digest.readUInt16BE(2) / 0xffff / 2) * APPROX_OFFSET_M;
  const dLat = (distance * Math.cos(angle)) / METRES_PER_DEGREE;
  const dLng = (distance * Math.sin(angle)) / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return { lat: round(lat + dLat), lng: round(lng + dLng), radiusM: APPROX_RADIUS_M };
}
