import { Schema, model, type Types } from 'mongoose';
import type { PlatformSettings } from './platform-settings.schemas.js';

/** The `platformSettings` collection holds this one document. */
export const PLATFORM_SETTINGS_ID = 'platform';

/**
 * The saved settings. They're checked by platformSettingsSchema (Zod) rather than Mongoose, and read over
 * the launch defaults, so a setting added later works before anyone saves it.
 */
export interface PlatformSettingsRecord {
  _id: string;
  settings: Partial<PlatformSettings>;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const platformSettingsSchema = new Schema<PlatformSettingsRecord>(
  {
    _id: { type: String, required: true },
    settings: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { collection: 'platformSettings', timestamps: true, minimize: false },
);

export const PlatformSettingsModel = model<PlatformSettingsRecord>(
  'PlatformSettings',
  platformSettingsSchema,
);
