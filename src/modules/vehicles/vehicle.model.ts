import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import {
  NZ_REGIONS,
  cents,
  nzAddressSchema,
  pointSchema,
  ratingSchema,
  type GeoPoint,
  type NzAddress,
  type NzRegion,
  type Rating,
} from '../../lib/model-fields.js';

export const BODY_TYPES = [
  'HATCHBACK',
  'SEDAN',
  'WAGON',
  'SUV',
  'UTE',
  'VAN',
  'PEOPLE_MOVER',
  'COUPE',
  'CONVERTIBLE',
] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const FUEL_TYPES = ['PETROL', 'DIESEL', 'HYBRID', 'PHEV', 'EV'] as const;
export type FuelType = (typeof FUEL_TYPES)[number];

export const TRANSMISSIONS = ['AUTOMATIC', 'MANUAL'] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];

/** Return at the level collected, or full. EVs use battery %. */
export const FUEL_POLICIES = ['SAME_LEVEL', 'FULL'] as const;
export type FuelPolicy = (typeof FUEL_POLICIES)[number];

export const VEHICLE_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'REJECTED',
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const PHOTO_TYPES = [
  'FRONT',
  'REAR',
  'DRIVER',
  'PASSENGER',
  'INTERIOR',
  'DASH',
  'BOOT',
  'TYRES',
  'DAMAGE',
] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** Set by the automatic checks in the browser, or by support staff (plan §9, Days 8–11). */
export const PHOTO_QUALITY_FLAGS = ['OK', 'LOW_RES', 'DARK', 'BLURRY', 'ADMIN_FLAGGED'] as const;

export const DOCUMENT_TYPES = ['REGO', 'WOF', 'COF', 'RUC', 'INSURANCE', 'OWNER_CONSENT', 'OTHER'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DELIVERY_TYPES = ['PICKUP', 'DELIVERY', 'AIRPORT', 'CUSTOM'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

/** A 17-character VIN, which never uses I, O or Q (plan §3, Validation rules). */
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export interface VehiclePhoto {
  _id?: Types.ObjectId;
  type: PhotoType;
  url: string;
  order: number;
  qualityFlag: (typeof PHOTO_QUALITY_FLAGS)[number];
  /** New photos on a live listing wait for support staff (plan §3, listing moderation). */
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

export interface VehicleDocumentFile {
  _id?: Types.ObjectId;
  type: DocumentType;
  /** A private file, shown only through short-lived signed URLs. */
  url: string;
  expiry?: Date;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  reviewedBy?: Types.ObjectId;
}

export interface DeliveryOption {
  _id?: Types.ObjectId;
  type: DeliveryType;
  label: string;
  address?: NzAddress;
  /** IATA code of the airport, for AIRPORT options (e.g. AKL). */
  airportCode?: string;
  feeCents: number;
  radiusKm?: number;
  /** E.g. where to meet at the airport. Shown once the booking is confirmed. */
  instructions?: string;
}

/** E.g. unavailable every weekday 8am–6pm. Expanded into RECURRING availability blocks. */
export interface RecurringRule {
  _id?: Types.ObjectId;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: number[];
  /** HH:mm, NZ time. */
  startTime: string;
  endTime: string;
}

export interface MaintenanceReminder {
  _id?: Types.ObjectId;
  title: string;
  dueAt?: Date;
  dueOdometer?: number;
  notes?: string;
  doneAt?: Date;
}

export interface Powertrain {
  engineCc?: number;
  cylinders?: number;
  description?: string;
  evRangeKm?: number;
  batteryKwh?: number;
}

export interface VehiclePricing {
  dailyCents: number;
  weeklyDiscountPct: number;
  monthlyDiscountPct: number;
  extraKmCents: number;
}

export interface TripRules {
  minDays: number;
  maxDays: number;
  minNoticeHours: number;
  /** Preparation time between trips, blocked as a BUFFER. */
  bufferHours: number;
  instantBook: boolean;
  /** One of the tiers allowed in platformSettings. */
  cancellationTier?: string;
}

/**
 * The `vehicles` collection (plan §3). A draft is saved at every onboarding step, so only the owner and
 * slug are required here; the Zod schemas check the rest when the Host submits the listing.
 */
export interface Vehicle {
  hostId: Types.ObjectId;
  slug: string;
  /** Stored in capitals without spaces. Not shown publicly (plan §3, Key rules). */
  regoPlate?: string;
  vin?: string;
  /** NZ imports often have a chassis number instead of a VIN; one of the two is required. */
  chassisNo?: string;
  make?: string;
  model?: string;
  year?: number;
  variant?: string;
  transmission?: Transmission;
  bodyType?: BodyType;
  fuelType?: FuelType;
  seats?: number;
  doors?: number;
  features: string[];
  wofExpiry?: Date;
  regoExpiry?: Date;
  /** For vehicles that need a Certificate of Fitness instead of a WOF. */
  cofExpiry?: Date;
  /** Road User Charges licence end reading (diesel, EV and PHEV). */
  rucValidToKm?: number;
  powertrain?: Powertrain;
  fuelPolicy: FuelPolicy;
  kmAllowancePerDay?: number;
  unlimitedKm: boolean;
  petFriendly: boolean;
  childSeat: boolean;
  /** Existing damage the Host declares; flagged to support when there's no damage photo (plan §9, Days 8–11). */
  damageNotes?: string;
  /** False when someone else is the registered owner: their written consent is then required (plan §3). */
  ownerIsHost: boolean;
  pricing?: VehiclePricing;
  rules: TripRules;
  status: VehicleStatus;
  reviewNotes?: string;
  onboardingStep: number;
  location?: GeoPoint;
  suburb?: string;
  city?: string;
  region?: NzRegion;
  rating: Rating;
  tripCount: number;
  /** Written first in every booking transaction, so simultaneous bookings for this car conflict (plan §3). */
  bookingSeq: number;
  photos: VehiclePhoto[];
  documents: VehicleDocumentFile[];
  deliveryOptions: DeliveryOption[];
  recurringRules: RecurringRule[];
  maintenanceReminders: MaintenanceReminder[];
  createdAt: Date;
  updatedAt: Date;
}

const percent = { type: Number, min: 0, max: 100, default: 0 };

const photoSchema = new Schema<VehiclePhoto>({
  type: { type: String, enum: PHOTO_TYPES, required: true },
  url: { type: String, required: true },
  order: { type: Number, default: 0 },
  qualityFlag: { type: String, enum: PHOTO_QUALITY_FLAGS, default: 'OK' },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
});

const documentSchema = new Schema<VehicleDocumentFile>({
  type: { type: String, enum: DOCUMENT_TYPES, required: true },
  url: { type: String, required: true },
  expiry: Date,
  status: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'], default: 'PENDING' },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
});

const deliveryOptionSchema = new Schema<DeliveryOption>({
  type: { type: String, enum: DELIVERY_TYPES, required: true },
  label: { type: String, required: true, trim: true },
  address: { type: nzAddressSchema },
  airportCode: { type: String, uppercase: true, match: [/^[A-Z]{3}$/, 'airportCode must be an IATA code'] },
  feeCents: cents({ default: 0 }),
  radiusKm: { type: Number, min: 0 },
  instructions: { type: String, maxlength: 1000 },
});

const timeOfDay = { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ };

const recurringRuleSchema = new Schema<RecurringRule>({
  daysOfWeek: {
    type: [{ type: Number, min: 0, max: 6 }],
    validate: { validator: (days: number[]) => days.length > 0, message: 'choose at least one day' },
  },
  startTime: timeOfDay,
  endTime: timeOfDay,
});

const maintenanceReminderSchema = new Schema<MaintenanceReminder>({
  title: { type: String, required: true, trim: true },
  dueAt: Date,
  dueOdometer: { type: Number, min: 0 },
  notes: String,
  doneAt: Date,
});

const vehicleSchema = new Schema<Vehicle>(
  {
    hostId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    regoPlate: {
      type: String,
      uppercase: true,
      set: (plate?: string) => plate?.replace(/\s+/g, ''),
      match: [/^[A-Z0-9]{1,6}$/, 'regoPlate must be 1–6 letters and numbers'],
    },
    vin: { type: String, uppercase: true, trim: true, match: [VIN_PATTERN, 'vin must be 17 characters'] },
    chassisNo: { type: String, uppercase: true, trim: true },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    year: { type: Number, min: 1900 },
    variant: { type: String, trim: true },
    transmission: { type: String, enum: TRANSMISSIONS },
    bodyType: { type: String, enum: BODY_TYPES },
    fuelType: { type: String, enum: FUEL_TYPES },
    seats: { type: Number, min: 1 },
    doors: { type: Number, min: 1 },
    features: { type: [String], default: [] },
    wofExpiry: Date,
    regoExpiry: Date,
    cofExpiry: Date,
    rucValidToKm: { type: Number, min: 0 },
    powertrain: {
      type: new Schema<Powertrain>(
        {
          engineCc: { type: Number, min: 0 },
          cylinders: { type: Number, min: 0 },
          description: String,
          evRangeKm: { type: Number, min: 0 },
          batteryKwh: { type: Number, min: 0 },
        },
        { _id: false },
      ),
      default: undefined,
    },
    fuelPolicy: { type: String, enum: FUEL_POLICIES, default: 'SAME_LEVEL' },
    kmAllowancePerDay: { type: Number, min: 0 },
    unlimitedKm: { type: Boolean, default: false },
    petFriendly: { type: Boolean, default: false },
    childSeat: { type: Boolean, default: false },
    damageNotes: { type: String, trim: true, maxlength: 1000 },
    ownerIsHost: { type: Boolean, default: true },
    pricing: {
      type: new Schema<VehiclePricing>(
        {
          dailyCents: cents({ required: true }),
          weeklyDiscountPct: percent,
          monthlyDiscountPct: percent,
          extraKmCents: cents({ default: 0 }),
        },
        { _id: false },
      ),
      default: undefined,
    },
    rules: {
      type: new Schema<TripRules>(
        {
          minDays: { type: Number, min: 1, default: 1 },
          maxDays: { type: Number, min: 1, default: 30 },
          minNoticeHours: { type: Number, min: 0, default: 12 },
          bufferHours: { type: Number, min: 0, default: 2 },
          instantBook: { type: Boolean, default: false },
          cancellationTier: String,
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    status: { type: String, enum: VEHICLE_STATUSES, default: 'DRAFT' },
    reviewNotes: String,
    onboardingStep: { type: Number, min: 1, max: 6, default: 1 },
    location: { type: pointSchema },
    suburb: { type: String, trim: true },
    city: { type: String, trim: true },
    region: { type: String, enum: NZ_REGIONS },
    rating: { type: ratingSchema, default: () => ({}) },
    tripCount: { type: Number, min: 0, default: 0 },
    bookingSeq: { type: Number, default: 0 },
    photos: { type: [photoSchema], default: [] },
    documents: { type: [documentSchema], default: [] },
    deliveryOptions: { type: [deliveryOptionSchema], default: [] },
    recurringRules: { type: [recurringRuleSchema], default: [] },
    maintenanceReminders: { type: [maintenanceReminderSchema], default: [] },
  },
  { timestamps: true },
);

// Location search: one $geoNear over live cars (plan §3, Key rules).
vehicleSchema.index({ location: '2dsphere', status: 1 });
vehicleSchema.index({ hostId: 1 });
vehicleSchema.index({ make: 1, model: 1 });
// A plate may be on only one live listing; the listing service checks it with this index.
vehicleSchema.index({ regoPlate: 1 });

export const VehicleModel = model<Vehicle>('Vehicle', vehicleSchema);
export type VehicleDocument = HydratedDocument<Vehicle>;
