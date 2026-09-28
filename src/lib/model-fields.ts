import { Schema } from 'mongoose';

/*
 * Field types shared by the Mongoose models (plan §3, Key rules and Validation rules).
 */

/** The 16 regions of New Zealand, used in addresses, places and listings. */
export const NZ_REGIONS = [
  'Northland',
  'Auckland',
  'Waikato',
  'Bay of Plenty',
  'Gisborne',
  "Hawke's Bay",
  'Taranaki',
  'Manawatū-Whanganui',
  'Wellington',
  'Tasman',
  'Nelson',
  'Marlborough',
  'West Coast',
  'Canterbury',
  'Otago',
  'Southland',
] as const;
export type NzRegion = (typeof NZ_REGIONS)[number];

const wholeCents = { validator: Number.isInteger, message: '{PATH} must be a whole number of cents' };

/** Money: whole cents in NZD, never negative. */
export function cents(options: { required?: boolean; default?: number } = {}) {
  return { type: Number, min: 0, validate: wholeCents, ...options };
}

/** Whole cents that may be negative. Only for price lines that take money off, such as a weekly discount. */
export function signedCents(options: { required?: boolean } = {}) {
  return { type: Number, validate: wholeCents, ...options };
}

/** A GeoJSON point. MongoDB's order is [longitude, latitude]. */
export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

export function point(lng: number, lat: number): GeoPoint {
  return { type: 'Point', coordinates: [lng, lat] };
}

function isLngLat(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [lng, lat] = value as number[];
  return (
    Number.isFinite(lng) && Number.isFinite(lat) && lng! >= -180 && lng! <= 180 && lat! >= -90 && lat! <= 90
  );
}

export const pointSchema = new Schema<GeoPoint>(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: { validator: isLngLat, message: 'coordinates must be [longitude, latitude]' },
    },
  },
  { _id: false },
);

/**
 * One structured NZ address format everywhere (plan §3): unit, street number and name, suburb,
 * town or city, region, postcode and coordinates.
 */
export interface NzAddress {
  unit?: string;
  streetNumber?: string;
  street: string;
  suburb?: string;
  city: string;
  region: NzRegion;
  postcode: string;
  location: GeoPoint;
}

export const nzAddressSchema = new Schema<NzAddress>(
  {
    unit: { type: String, trim: true },
    streetNumber: { type: String, trim: true },
    street: { type: String, required: true, trim: true },
    suburb: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    region: { type: String, enum: NZ_REGIONS, required: true },
    postcode: { type: String, required: true, match: [/^\d{4}$/, 'postcode must be 4 digits'] },
    location: { type: pointSchema, required: true },
  },
  { _id: false },
);

/** An average star rating and how many reviews it's from, kept up to date when reviews publish. */
export interface Rating {
  avg: number;
  count: number;
}

export const ratingSchema = new Schema<Rating>(
  {
    avg: { type: Number, min: 0, max: 5, default: 0 },
    count: { type: Number, min: 0, default: 0 },
  },
  { _id: false },
);

/** A private file attached to a message, incident or support ticket, shown through signed URLs (plan §3). */
export interface FileAttachment {
  url: string;
  name?: string;
  contentType?: string;
}

export const attachmentSchema = new Schema<FileAttachment>(
  { url: { type: String, required: true }, name: String, contentType: String },
  { _id: false },
);

/** A whole-star score of 1–5 (plan §3: ratings of 1–5 whole stars in every category). */
export function stars(options: { required?: boolean } = {}) {
  return {
    type: Number,
    min: 1,
    max: 5,
    validate: { validator: Number.isInteger, message: '{PATH} must be a whole number of stars' },
    ...options,
  };
}
