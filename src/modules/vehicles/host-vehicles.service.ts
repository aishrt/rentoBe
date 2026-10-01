import mongoose, { type Types } from 'mongoose';
import { env } from '../../env.js';
import { fileLink, getStorage } from '../../integrations/storage/storage.js';
import { HttpError, forbidden, unauthenticated } from '../../lib/http-error.js';
import { forget } from '../../lib/memo.js';
import { point } from '../../lib/model-fields.js';
import { fromNzWallClock, nzDate, parseNzDateTime } from '../../lib/nz-time.js';
import { slugify } from '../../lib/slug.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import type { PlatformSettings } from '../admin/platform-settings.schemas.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  addBlock,
  calendarBlocks,
  rebuildRecurringBlocks,
  removeBlock,
} from '../availability/availability.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { hostAnswers } from '../bookings/booking-view.js';
import { notify } from '../notifications/notify.js';
import { PlaceModel } from '../search/place.model.js';
import { uploadFolder } from '../uploads/upload-folders.js';
import { UserModel } from '../users/user.model.js';
import type { HostVehicleView, VehiclePatch } from './host-vehicles.schemas.js';
import { listingChecklist } from './listing-checklist.js';
import { vehicleTitle } from './vehicle-view.js';
import {
  VehicleModel,
  type DeliveryOption,
  type VehicleDocument,
  type VehicleStatus,
} from './vehicle.model.js';

/*
 * Host vehicle onboarding (plan §9, Days 8–11): drafts saved at every step, uploads, the missing-items
 * check and submission for review, and the rules for editing a live listing (plan §3, changes to live
 * listings): price, rules and delivery changes apply at once, new photos and documents wait for
 * support staff, and a new plate, VIN, chassis number, make, model or year sends it back for review.
 */

const LIVE: VehicleStatus[] = ['ACTIVE', 'INACTIVE'];
/** Statuses that hold a plate: a plate can be on only one of these (plan §3, Validation rules). */
const LISTED: VehicleStatus[] = ['UNDER_REVIEW', 'CHANGES_REQUESTED', 'ACTIVE', 'INACTIVE', 'SUSPENDED'];
const KEY_FIELDS = ['regoPlate', 'vin', 'chassisNo', 'make', 'model', 'year'] as const;
const MAX_PHOTOS = 30;
const MAX_DOCUMENTS = 15;

const siteUrl = () => env.FRONTEND_URL.replace(/\/+$/, '');
const invalid = (fields: Record<string, string>) =>
  new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', fields);
const notFound = () => new HttpError(404, 'NOT_FOUND', "We couldn't find that car in your listings.");

/** An expiry date is good until the end of that day in NZ. */
function expiryFromDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return fromNzWallClock(year, month, day, 23, 59);
}

async function hostUser(userId: string) {
  const user = await UserModel.findById(userId).select('status firstName hostProfile roles');
  if (!user || user.status !== 'ACTIVE') throw unauthenticated();
  if (!user.hostProfile || user.hostProfile.status === 'REJECTED') {
    throw new HttpError(403, 'NOT_A_HOST', 'Apply to host before adding a car.');
  }
  if (user.hostProfile.status === 'SUSPENDED') {
    throw new HttpError(403, 'HOST_SUSPENDED', 'Your hosting is suspended. Please contact support.');
  }
  return user;
}

export async function ownVehicle(userId: string, id: string): Promise<VehicleDocument> {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const vehicle = await VehicleModel.findById(id);
  if (!vehicle) throw notFound();
  if (!vehicle.hostId.equals(userId)) throw forbidden();
  return vehicle;
}

export function toHostVehicleView(
  vehicle: VehicleDocument,
  settings: PlatformSettings,
  now = new Date(),
): HostVehicleView {
  const day = (value?: Date) => (value ? nzDate(value) : undefined);
  return {
    id: vehicle.id,
    slug: vehicle.slug,
    title: vehicleTitle(vehicle),
    status: vehicle.status,
    ...(vehicle.reviewNotes && { reviewNotes: vehicle.reviewNotes }),
    onboardingStep: vehicle.onboardingStep,
    ...(vehicle.regoPlate && { regoPlate: vehicle.regoPlate }),
    ...(vehicle.vin && { vin: vehicle.vin }),
    ...(vehicle.chassisNo && { chassisNo: vehicle.chassisNo }),
    ...(vehicle.make && { make: vehicle.make }),
    ...(vehicle.model && { model: vehicle.model }),
    ...(vehicle.year && { year: vehicle.year }),
    ...(vehicle.variant && { variant: vehicle.variant }),
    ...(vehicle.bodyType && { bodyType: vehicle.bodyType }),
    ...(vehicle.fuelType && { fuelType: vehicle.fuelType }),
    ...(vehicle.transmission && { transmission: vehicle.transmission }),
    ...(vehicle.seats && { seats: vehicle.seats }),
    ...(vehicle.doors && { doors: vehicle.doors }),
    ...(vehicle.powertrain && { powertrain: vehicle.powertrain }),
    features: vehicle.features,
    petFriendly: vehicle.petFriendly,
    childSeat: vehicle.childSeat,
    ...(vehicle.damageNotes && { damageNotes: vehicle.damageNotes }),
    ...(vehicle.regoExpiry && { regoExpiry: day(vehicle.regoExpiry) }),
    ...(vehicle.wofExpiry && { wofExpiry: day(vehicle.wofExpiry) }),
    ...(vehicle.cofExpiry && { cofExpiry: day(vehicle.cofExpiry) }),
    ...(vehicle.rucValidToKm !== undefined && { rucValidToKm: vehicle.rucValidToKm }),
    ownerIsHost: vehicle.ownerIsHost,
    ...(vehicle.pricing && {
      pricing: {
        dailyCents: vehicle.pricing.dailyCents,
        weeklyDiscountPct: vehicle.pricing.weeklyDiscountPct,
        monthlyDiscountPct: vehicle.pricing.monthlyDiscountPct,
        extraKmCents: vehicle.pricing.extraKmCents,
      },
    }),
    ...(vehicle.kmAllowancePerDay !== undefined && { kmAllowancePerDay: vehicle.kmAllowancePerDay }),
    unlimitedKm: vehicle.unlimitedKm,
    fuelPolicy: vehicle.fuelPolicy,
    rules: {
      minDays: vehicle.rules.minDays,
      maxDays: vehicle.rules.maxDays,
      minNoticeHours: vehicle.rules.minNoticeHours,
      bufferHours: vehicle.rules.bufferHours,
      instantBook: vehicle.rules.instantBook,
      ...(vehicle.rules.cancellationTier && { cancellationTier: vehicle.rules.cancellationTier }),
    },
    photos: vehicle.photos.map((photo) => ({
      id: photo._id!.toString(),
      type: photo.type,
      url: photo.url,
      status: photo.status,
      qualityFlag: photo.qualityFlag,
    })),
    documents: vehicle.documents.map((document) => ({
      id: document._id!.toString(),
      type: document.type,
      status: document.status,
      ...(document.expiry && { expiry: day(document.expiry) }),
      link: fileLink(document.url),
    })),
    deliveryOptions: vehicle.deliveryOptions.map((option) => ({
      id: option._id!.toString(),
      type: option.type,
      label: option.label,
      ...(option.address && {
        address: {
          ...(option.address.unit && { unit: option.address.unit }),
          ...(option.address.streetNumber && { streetNumber: option.address.streetNumber }),
          street: option.address.street,
          ...(option.address.suburb && { suburb: option.address.suburb }),
          city: option.address.city,
          region: option.address.region,
          postcode: option.address.postcode,
          lat: option.address.location.coordinates[1],
          lng: option.address.location.coordinates[0],
        },
      }),
      ...(option.airportCode && { airportCode: option.airportCode }),
      feeCents: option.feeCents,
      ...(option.radiusKm !== undefined && { radiusKm: option.radiusKm }),
      ...(option.instructions && { instructions: option.instructions }),
    })),
    recurringRules: vehicle.recurringRules.map((rule) => ({
      id: rule._id!.toString(),
      daysOfWeek: rule.daysOfWeek,
      startTime: rule.startTime,
      endTime: rule.endTime,
    })),
    ...(vehicle.suburb && { suburb: vehicle.suburb }),
    ...(vehicle.city && { city: vehicle.city }),
    rating: vehicle.rating,
    tripCount: vehicle.tripCount,
    checklist: listingChecklist(vehicle, settings, now),
    createdAt: vehicle.createdAt.toISOString(),
    updatedAt: vehicle.updatedAt.toISOString(),
  };
}

/** POST /host/vehicles: a new draft, where onboarding step 1 starts. */
export async function createDraft(userId: string): Promise<HostVehicleView> {
  await hostUser(userId);
  const settings = await getPlatformSettings();
  const vehicle = await VehicleModel.create({
    hostId: userId,
    slug: `draft-${new mongoose.Types.ObjectId().toString()}`,
    rules: { cancellationTier: settings.cancellation.defaultTier },
  });
  return toHostVehicleView(vehicle, settings);
}

/** GET /host/vehicles: My Vehicles, with what's left for each (plan §11). */
export async function listHostVehicles(userId: string) {
  const [vehicles, settings] = await Promise.all([
    VehicleModel.find({ hostId: userId }).sort({ updatedAt: -1 }),
    getPlatformSettings(),
  ]);
  return vehicles.map((vehicle) => {
    const cover =
      vehicle.photos.find((photo) => photo.type === 'FRONT' && photo.status !== 'REJECTED') ??
      vehicle.photos.find((photo) => photo.status !== 'REJECTED');
    return {
      id: vehicle.id,
      slug: vehicle.slug,
      title: vehicleTitle(vehicle),
      status: vehicle.status,
      onboardingStep: vehicle.onboardingStep,
      photo: cover?.url ?? null,
      missingCount: listingChecklist(vehicle, settings).missing.length,
      pendingChanges:
        LIVE.includes(vehicle.status) &&
        (vehicle.photos.some((photo) => photo.status === 'PENDING') ||
          vehicle.documents.some((document) => document.status === 'PENDING')),
      dailyCents: vehicle.pricing?.dailyCents ?? null,
      updatedAt: vehicle.updatedAt.toISOString(),
    };
  });
}

export async function getHostVehicle(userId: string, id: string): Promise<HostVehicleView> {
  const [vehicle, settings] = await Promise.all([ownVehicle(userId, id), getPlatformSettings()]);
  return toHostVehicleView(vehicle, settings);
}

function assertEditable(vehicle: VehicleDocument) {
  if (vehicle.status === 'SUSPENDED') {
    throw new HttpError(409, 'NOT_EDITABLE', 'This car is suspended. Please contact support.');
  }
  if (vehicle.status === 'REJECTED') {
    throw new HttpError(409, 'NOT_EDITABLE', "This listing wasn't approved, so it can't be changed.");
  }
}

async function assertPlateFree(plate: string, vehicleId: Types.ObjectId) {
  const other = await VehicleModel.exists({
    regoPlate: plate,
    _id: mongoose.trusted({ $ne: vehicleId }),
    status: mongoose.trusted({ $in: LISTED }),
  });
  if (other) {
    throw new HttpError(409, 'PLATE_TAKEN', 'This number plate is already on another listing.', {
      regoPlate: 'This number plate is already on another listing. Contact support if it’s your car.',
    });
  }
}

async function buildDeliveryOptions(
  inputs: NonNullable<VehiclePatch['deliveryOptions']>,
  existing: DeliveryOption[],
): Promise<DeliveryOption[]> {
  const pickups = inputs.filter((option) => option.type === 'PICKUP');
  if (pickups.length !== 1)
    throw invalid({ deliveryOptions: 'Add one pickup location: where guests collect the car' });

  const options: DeliveryOption[] = [];
  for (const [index, input] of inputs.entries()) {
    const field = `deliveryOptions.${index}`;
    const kept = input.id ? existing.find((option) => option._id?.toString() === input.id) : undefined;
    const address = input.address
      ? {
          unit: input.address.unit,
          streetNumber: input.address.streetNumber,
          street: input.address.street,
          suburb: input.address.suburb,
          city: input.address.city,
          region: input.address.region,
          postcode: input.address.postcode,
          location: point(input.address.lng, input.address.lat),
        }
      : undefined;
    let label = input.label;

    switch (input.type) {
      case 'PICKUP':
        if (!address) throw invalid({ [`${field}.address`]: 'Add the pickup address' });
        label ??= [address.suburb, address.city].filter(Boolean).join(', ');
        break;
      case 'CUSTOM':
        if (!address) throw invalid({ [`${field}.address`]: 'Add the address of this delivery point' });
        if (!label) throw invalid({ [`${field}.label`]: 'Name this delivery point, e.g. "Ferry terminal"' });
        break;
      case 'DELIVERY':
        if (input.radiusKm === undefined)
          throw invalid({ [`${field}.radiusKm`]: 'How far will you deliver?' });
        label ??= 'Delivery to your address';
        break;
      case 'AIRPORT': {
        const airport = input.airportCode
          ? await PlaceModel.findOne({ type: 'AIRPORT', code: input.airportCode.toUpperCase() }).lean()
          : null;
        if (!airport) throw invalid({ [`${field}.airportCode`]: 'Choose an airport' });
        label = airport.name;
        break;
      }
    }

    options.push({
      ...(kept?._id && { _id: kept._id }),
      type: input.type,
      label: label!,
      ...(address && { address }),
      ...(input.type === 'AIRPORT' && { airportCode: input.airportCode!.toUpperCase() }),
      feeCents: input.type === 'PICKUP' ? 0 : input.feeCents,
      ...(input.type === 'DELIVERY' && { radiusKm: input.radiusKm }),
      ...(input.instructions && { instructions: input.instructions }),
    });
  }
  return options;
}

/** PATCH /host/vehicles/{id}: saves one onboarding step, or an edit to a live listing. */
export async function patchVehicle(
  userId: string,
  id: string,
  patch: VehiclePatch,
  ip?: string,
): Promise<HostVehicleView> {
  await hostUser(userId);
  const vehicle = await ownVehicle(userId, id);
  assertEditable(vehicle);
  const settings = await getPlatformSettings();
  const limits = settings.vehicles;
  const fields: Record<string, string> = {};

  const nextYear = new Date().getFullYear() + 1;
  if (patch.year !== undefined && patch.year > nextYear) fields.year = `The year can be up to ${nextYear}`;
  if (patch.seats !== undefined && (patch.seats < limits.seats.min || patch.seats > limits.seats.max)) {
    fields.seats = `Seats must be ${limits.seats.min}–${limits.seats.max}`;
  }
  if (patch.doors !== undefined && (patch.doors < limits.doors.min || patch.doors > limits.doors.max)) {
    fields.doors = `Doors must be ${limits.doors.min}–${limits.doors.max}`;
  }
  if (patch.pricing) {
    const { min, max } = limits.dailyPriceCents;
    if (patch.pricing.dailyCents < min || patch.pricing.dailyCents > max) {
      fields['pricing.dailyCents'] = `The daily price must be $${min / 100}–$${max / 100}`;
    }
    for (const key of ['weeklyDiscountPct', 'monthlyDiscountPct'] as const) {
      if (patch.pricing[key] > limits.maxDiscountPct)
        fields[`pricing.${key}`] = `Discounts can be up to ${limits.maxDiscountPct}%`;
    }
  }
  const minDays = patch.rules?.minDays ?? vehicle.rules.minDays;
  const maxDays = patch.rules?.maxDays ?? vehicle.rules.maxDays;
  if (minDays > maxDays) fields['rules.minDays'] = "The minimum trip can't be longer than the maximum";
  if (
    patch.rules?.cancellationTier &&
    !settings.cancellation.hostSelectableTiers.includes(patch.rules.cancellationTier)
  ) {
    fields['rules.cancellationTier'] = 'Choose one of the cancellation policies';
  }
  for (const key of ['regoExpiry', 'wofExpiry', 'cofExpiry'] as const) {
    const value = patch[key];
    if (value && Number.isNaN(expiryFromDate(value).getTime())) fields[key] = 'Enter a real date';
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);

  if (patch.regoPlate && patch.regoPlate !== vehicle.regoPlate)
    await assertPlateFree(patch.regoPlate, vehicle._id);

  const before = Object.fromEntries(KEY_FIELDS.map((key) => [key, vehicle[key]]));
  const set = <Key extends keyof VehiclePatch>(
    key: Key,
    apply: (value: NonNullable<VehiclePatch[Key]>) => void,
  ) => {
    const value = patch[key];
    if (value !== undefined && value !== null) apply(value as NonNullable<VehiclePatch[Key]>);
  };
  const clearable = [
    'vin',
    'chassisNo',
    'variant',
    'powertrain',
    'damageNotes',
    'wofExpiry',
    'cofExpiry',
    'rucValidToKm',
    'kmAllowancePerDay',
  ] as const;
  for (const key of clearable) if (patch[key] === null) vehicle.set(key, undefined);

  set('regoPlate', (value) => (vehicle.regoPlate = value));
  set('vin', (value) => (vehicle.vin = value));
  set('chassisNo', (value) => (vehicle.chassisNo = value));
  set('make', (value) => (vehicle.make = value));
  // `vehicle.model` is also Mongoose's model() method, so this one goes through set().
  set('model', (value) => vehicle.set('model', value));
  set('year', (value) => (vehicle.year = value));
  set('variant', (value) => (vehicle.variant = value));
  set('bodyType', (value) => (vehicle.bodyType = value));
  set('fuelType', (value) => (vehicle.fuelType = value));
  set('transmission', (value) => (vehicle.transmission = value));
  set('seats', (value) => (vehicle.seats = value));
  set('doors', (value) => (vehicle.doors = value));
  set('powertrain', (value) => vehicle.set('powertrain', value));
  set('features', (value) => (vehicle.features = [...new Set(value)]));
  set('petFriendly', (value) => (vehicle.petFriendly = value));
  set('childSeat', (value) => (vehicle.childSeat = value));
  set('damageNotes', (value) => (vehicle.damageNotes = value));
  set('regoExpiry', (value) => (vehicle.regoExpiry = expiryFromDate(value)));
  set('wofExpiry', (value) => (vehicle.wofExpiry = expiryFromDate(value)));
  set('cofExpiry', (value) => (vehicle.cofExpiry = expiryFromDate(value)));
  set('rucValidToKm', (value) => (vehicle.rucValidToKm = value));
  set('ownerIsHost', (value) => (vehicle.ownerIsHost = value));
  set('pricing', (value) => vehicle.set('pricing', value));
  set('kmAllowancePerDay', (value) => (vehicle.kmAllowancePerDay = value));
  set('unlimitedKm', (value) => (vehicle.unlimitedKm = value));
  set('fuelPolicy', (value) => (vehicle.fuelPolicy = value));
  set('rules', (value) => {
    for (const [key, ruleValue] of Object.entries(value)) {
      if (ruleValue !== undefined) vehicle.set(`rules.${key}`, ruleValue);
    }
  });
  if (patch.deliveryOptions) {
    const options = await buildDeliveryOptions(patch.deliveryOptions, vehicle.deliveryOptions);
    vehicle.set('deliveryOptions', options);
    // The car is found in search where guests collect it (plan §3, location search).
    const pickup = options.find((option) => option.type === 'PICKUP')!;
    vehicle.location = pickup.address!.location;
    vehicle.suburb = pickup.address!.suburb;
    vehicle.city = pickup.address!.city;
    vehicle.region = pickup.address!.region;
  }
  if (patch.onboardingStep) vehicle.onboardingStep = patch.onboardingStep;

  const changedKeys = KEY_FIELDS.filter((key) => String(before[key] ?? '') !== String(vehicle[key] ?? ''));
  if (LIVE.includes(vehicle.status) && changedKeys.length > 0) {
    vehicle.status = 'UNDER_REVIEW';
    vehicle.reviewNotes = undefined;
    await recordAudit({
      actorId: userId,
      action: 'vehicle.key-details-changed',
      entity: 'vehicle',
      entityId: vehicle.id,
      before: Object.fromEntries(changedKeys.map((key) => [key, before[key]])),
      after: Object.fromEntries(changedKeys.map((key) => [key, vehicle[key]])),
      ip,
    });
  }

  await vehicle.save();
  forget('vehicles:featured');
  return toHostVehicleView(vehicle, settings);
}

/** DELETE /host/vehicles/{id}: throws away a draft that was never submitted. */
export async function deleteDraft(userId: string, id: string): Promise<void> {
  const vehicle = await ownVehicle(userId, id);
  if (vehicle.status !== 'DRAFT') {
    throw new HttpError(409, 'NOT_A_DRAFT', 'Only a draft can be deleted. Deactivate a listing instead.');
  }
  await vehicle.deleteOne();
}

/** POST /host/vehicles/{id}/photos: adds an uploaded photo. It shows publicly once support approves it. */
export async function attachPhoto(
  userId: string,
  id: string,
  input: {
    type: VehicleDocument['photos'][number]['type'];
    upload: string;
    width?: number;
    height?: number;
    qualityFlag: 'OK' | 'LOW_RES' | 'DARK' | 'BLURRY';
  },
): Promise<HostVehicleView> {
  const vehicle = await ownVehicle(userId, id);
  assertEditable(vehicle);
  if (vehicle.photos.length >= MAX_PHOTOS)
    throw new HttpError(409, 'TOO_MANY_PHOTOS', `A listing can have up to ${MAX_PHOTOS} photos.`);
  const settings = await getPlatformSettings();
  const url = await getStorage().confirmUpload({
    ...uploadFolder('VEHICLE_PHOTO', vehicle.id),
    ref: input.upload,
  });
  // The browser checks resolution, darkness and blur; the size is checked here as well (plan §9, Days 8–11).
  const small =
    input.width !== undefined &&
    input.height !== undefined &&
    Math.max(input.width, input.height) <
      Math.max(settings.vehicles.minPhotoWidthPx, settings.vehicles.minPhotoHeightPx);
  vehicle.photos.push({
    type: input.type,
    url,
    order: vehicle.photos.filter((photo) => photo.type === input.type).length,
    qualityFlag: small ? 'LOW_RES' : input.qualityFlag,
    status: 'PENDING',
  });
  await vehicle.save();
  return toHostVehicleView(vehicle, settings);
}

export async function removePhoto(userId: string, id: string, photoId: string): Promise<HostVehicleView> {
  const vehicle = await ownVehicle(userId, id);
  assertEditable(vehicle);
  if (!vehicle.photos.some((photo) => photo._id?.toString() === photoId)) {
    throw new HttpError(404, 'NOT_FOUND', 'No such photo.');
  }
  vehicle.set(
    'photos',
    vehicle.photos.filter((photo) => photo._id?.toString() !== photoId),
  );
  await vehicle.save();
  forget('vehicles:featured');
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

/** POST /host/vehicles/{id}/documents: a private file, checked by support staff. */
export async function attachDocument(
  userId: string,
  id: string,
  input: { type: VehicleDocument['documents'][number]['type']; upload: string; expiry?: string },
): Promise<HostVehicleView> {
  const vehicle = await ownVehicle(userId, id);
  assertEditable(vehicle);
  if (vehicle.documents.length >= MAX_DOCUMENTS) {
    throw new HttpError(409, 'TOO_MANY_DOCUMENTS', `A listing can have up to ${MAX_DOCUMENTS} documents.`);
  }
  const url = await getStorage().confirmUpload({
    ...uploadFolder('VEHICLE_DOCUMENT', vehicle.id),
    ref: input.upload,
  });
  vehicle.documents.push({
    type: input.type,
    url,
    ...(input.expiry && { expiry: expiryFromDate(input.expiry) }),
    status: 'PENDING',
  });
  await vehicle.save();
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

export async function removeDocument(
  userId: string,
  id: string,
  documentId: string,
): Promise<HostVehicleView> {
  const vehicle = await ownVehicle(userId, id);
  assertEditable(vehicle);
  if (!vehicle.documents.some((document) => document._id?.toString() === documentId)) {
    throw new HttpError(404, 'NOT_FOUND', 'No such document.');
  }
  vehicle.set(
    'documents',
    vehicle.documents.filter((document) => document._id?.toString() !== documentId),
  );
  await vehicle.save();
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

/** A readable, unique address for the listing page, set when it's first submitted. */
async function finalSlug(vehicle: VehicleDocument): Promise<string> {
  const base = slugify(`${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.city ?? ''}`) || 'car';
  for (let suffix = 1; ; suffix += 1) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    if (!(await VehicleModel.exists({ slug, _id: mongoose.trusted({ $ne: vehicle._id }) }))) return slug;
  }
}

/** POST /host/vehicles/{id}/submit: the missing-items check, then the review queue. */
export async function submitVehicle(userId: string, id: string, ip?: string): Promise<HostVehicleView> {
  const user = await hostUser(userId);
  const vehicle = await ownVehicle(userId, id);
  const settings = await getPlatformSettings();
  if (vehicle.status === 'UNDER_REVIEW') return toHostVehicleView(vehicle, settings);
  if (vehicle.status !== 'DRAFT' && vehicle.status !== 'CHANGES_REQUESTED') {
    throw new HttpError(409, 'ALREADY_SUBMITTED', 'This listing has already been reviewed.');
  }
  const checklist = listingChecklist(vehicle, settings);
  if (!checklist.complete) {
    throw new HttpError(
      400,
      'LISTING_INCOMPLETE',
      'A few things are missing before you can submit.',
      Object.fromEntries(checklist.missing.map((item) => [item.field, item.message])),
    );
  }
  await assertPlateFree(vehicle.regoPlate!, vehicle._id);

  if (vehicle.slug.startsWith('draft-')) vehicle.slug = await finalSlug(vehicle);
  vehicle.status = 'UNDER_REVIEW';
  vehicle.onboardingStep = 6;
  await vehicle.save();

  await recordAudit({
    actorId: userId,
    action: 'vehicle.submitted',
    entity: 'vehicle',
    entityId: vehicle.id,
    ip,
  });
  await notify({
    userId,
    type: 'LISTING_SUBMITTED',
    title: `Your ${vehicleTitle(vehicle)} is under review`,
    body: "We'll let you know as soon as it's approved.",
    link: `/host/vehicles/${vehicle.id}`,
    email: {
      template: 'listingSubmitted',
      props: {
        firstName: user.firstName,
        vehicleTitle: vehicleTitle(vehicle),
        url: `${siteUrl()}/host/vehicles/${vehicle.id}`,
      },
    },
  });
  return toHostVehicleView(vehicle, settings);
}

/** POST /host/vehicles/{id}/activate|deactivate: a live listing on or off search (plan §8.2). */
export async function setVehicleActive(
  userId: string,
  id: string,
  active: boolean,
): Promise<HostVehicleView> {
  const vehicle = await ownVehicle(userId, id);
  if (!LIVE.includes(vehicle.status)) {
    throw new HttpError(409, 'NOT_LIVE', 'Only an approved listing can be switched on or off.');
  }
  vehicle.status = active ? 'ACTIVE' : 'INACTIVE';
  await vehicle.save();
  forget('vehicles:featured');
  return toHostVehicleView(vehicle, await getPlatformSettings());
}

/** Accepts "2026-10-12" (the start of that NZ day) or a date and time. */
export function parseCalendarTime(value: string): Date | null {
  return parseNzDateTime(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value);
}

/** GET /host/vehicles/{id}/calendar: every block with its reason, and the booking behind it. */
export async function hostCalendar(vehicleId: Types.ObjectId, from: Date, to: Date) {
  const blocks = await calendarBlocks(vehicleId, from, to);
  const bookingIds = [
    ...new Set(blocks.flatMap((block) => (block.bookingId ? [block.bookingId.toString()] : []))),
  ];
  const bookings = bookingIds.length
    ? await BookingModel.find({ _id: mongoose.trusted({ $in: bookingIds }) })
        .select('ref status guestId instantBook hostAcceptedAt')
        .lean()
    : [];
  const guests = bookings.length
    ? await UserModel.find({ _id: mongoose.trusted({ $in: bookings.map((booking) => booking.guestId) }) })
        .select('firstName')
        .lean()
    : [];

  return blocks.map((block) => {
    const booking = block.bookingId
      ? bookings.find((candidate) => candidate._id.equals(block.bookingId!))
      : undefined;
    return {
      id: block._id.toString(),
      start: block.startAt.toISOString(),
      end: block.endAt.toISOString(),
      reason: block.reason,
      ...(block.note && { note: block.note }),
      ...(block.expiresAt && { holdExpiresAt: block.expiresAt.toISOString() }),
      ...(booking && {
        booking: {
          id: booking._id.toString(),
          ref: booking.ref,
          status: booking.status,
          toAnswer: hostAnswers(booking),
          guestFirstName: guests.find((guest) => guest._id.equals(booking.guestId))?.firstName ?? 'Guest',
        },
      }),
    };
  });
}

/** POST /host/vehicles/{id}/blocks (and the staff calendar override, plan §9, Days 10–11). */
export async function blockDates(
  vehicleId: Types.ObjectId,
  input: { start: string; end: string; note?: string },
  actorId: string,
  reason: 'HOST_BLOCK' | 'ADMIN',
) {
  const startAt = parseCalendarTime(input.start);
  const endAt = parseCalendarTime(input.end);
  if (!startAt) throw invalid({ start: 'Choose when the block starts' });
  if (!endAt) throw invalid({ end: 'Choose when the block ends' });
  const block = await addBlock({ vehicleId, startAt, endAt, reason, note: input.note, createdBy: actorId });
  return {
    id: block.id,
    start: block.startAt.toISOString(),
    end: block.endAt.toISOString(),
    reason: block.reason,
    ...(block.note && { note: block.note }),
  };
}

export async function unblockDates(
  vehicleId: Types.ObjectId,
  blockId: string,
  reasons: Parameters<typeof removeBlock>[2],
) {
  if (!(await removeBlock(vehicleId, blockId, reasons))) {
    throw new HttpError(404, 'NOT_FOUND', "That block isn't on this car's calendar, or it's a booking.");
  }
}

/** PUT /host/vehicles/{id}/recurring-rules: saves the rules and rebuilds 12 months of blocks. */
export async function setRecurringRules(
  userId: string,
  id: string,
  rules: { daysOfWeek: number[]; startTime: string; endTime: string }[],
) {
  const vehicle = await ownVehicle(userId, id);
  assertEditable(vehicle);
  vehicle.set(
    'recurringRules',
    rules.map((rule) => ({ ...rule, daysOfWeek: [...new Set(rule.daysOfWeek)].sort() })),
  );
  await vehicle.save();
  const result = await rebuildRecurringBlocks(vehicle._id);
  return {
    blocks: result.blocks,
    skipped: result.skipped.map((range) => ({
      start: range.startAt.toISOString(),
      end: range.endAt.toISOString(),
    })),
  };
}
