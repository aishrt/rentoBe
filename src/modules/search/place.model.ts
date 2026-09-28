import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { NZ_REGIONS, pointSchema, type GeoPoint, type NzRegion } from '../../lib/model-fields.js';

export const PLACE_TYPES = ['CITY', 'SUBURB', 'AIRPORT', 'DESTINATION'] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];

/**
 * Our own list of NZ places for location autocomplete, airport search and airport delivery options
 * (plan §3 `places`). Google Places fills in street addresses.
 */
export interface Place {
  type: PlaceType;
  name: string;
  /**
   * The name in lowercase without macrons, so "taupo" finds Taupō with an indexed prefix search.
   * Filled in from `name` on save.
   */
  searchName: string;
  region: NzRegion;
  /** IATA code, for airports (e.g. AKL). */
  code?: string;
  location: GeoPoint;
  /** The city a suburb or airport belongs to. */
  parentId?: Types.ObjectId;
  /** Orders suggestions; higher first. */
  popularity: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Lowercase, without macrons or other accents: "Whangārei" → "whangarei". */
export function toSearchName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

const placeSchema = new Schema<Place>(
  {
    type: { type: String, enum: PLACE_TYPES, required: true },
    name: { type: String, required: true, trim: true },
    searchName: { type: String, required: true },
    region: { type: String, enum: NZ_REGIONS, required: true },
    code: { type: String, uppercase: true, match: [/^[A-Z]{3}$/, 'code must be an IATA code'] },
    location: { type: pointSchema, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Place' },
    popularity: { type: Number, default: 0 },
  },
  { timestamps: true },
);

placeSchema.pre('validate', function fillSearchName() {
  if (this.name) this.searchName = toSearchName(this.name);
});

placeSchema.index({ location: '2dsphere' });
placeSchema.index({ type: 1, code: 1 });
// Autocomplete: an anchored prefix match on searchName uses this index. Plan §3 lists { name: 1 }; the
// normalised name lets visitors type without macrons.
placeSchema.index({ searchName: 1 });

export const PlaceModel = model<Place>('Place', placeSchema);
export type PlaceDocument = HydratedDocument<Place>;
