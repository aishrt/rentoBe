import mongoose, { Schema, model, type HydratedDocument } from 'mongoose';
import { NZ_REGIONS, pointSchema, type GeoPoint, type NzRegion } from '../../lib/model-fields.js';

/**
 * A city or destination landing page, `/rental/:slug` (plan §3 `destinations`, §1.4). Featured destinations
 * are the homepage tiles. Admins add more without code changes, and unpublish one to take it down.
 */
export interface Destination {
  slug: string;
  city: string;
  /** The te reo Māori name shown with the English one, e.g. Tāmaki Makaurau. */
  maoriName?: string;
  region: NzRegion;
  /** One line for the homepage tile. */
  tagline?: string;
  /** The landing page introduction. */
  intro: string;
  heroImage?: string;
  location: GeoPoint;
  /** IATA codes of the airports that serve it, from the `places` collection. */
  airports: string[];
  featured: boolean;
  order: number;
  /**
   * False: hidden from the homepage, its page answers 404 and the sitemap leaves it out. Pages saved
   * before this field existed have none and are published: filter with `publishedDestination()`.
   */
  published: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const destinationSchema = new Schema<Destination>(
  {
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug uses lowercase letters, numbers and dashes'],
    },
    city: { type: String, required: true, trim: true },
    maoriName: { type: String, trim: true },
    region: { type: String, enum: NZ_REGIONS, required: true },
    tagline: { type: String, trim: true, maxlength: 160 },
    intro: { type: String, required: true },
    heroImage: String,
    location: { type: pointSchema, required: true },
    airports: { type: [{ type: String, uppercase: true, match: /^[A-Z]{3}$/ }], default: [] },
    featured: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    published: { type: Boolean, default: true },
  },
  { timestamps: true },
);

destinationSchema.index({ slug: 1 }, { unique: true });

export const DestinationModel = model<Destination>('Destination', destinationSchema);
export type DestinationDocument = HydratedDocument<Destination>;

/** The published pages, including those saved before `published` existed (lean reads skip defaults). */
export const publishedDestination = () => ({ published: mongoose.trusted({ $ne: false }) });
