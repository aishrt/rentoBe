import { DEFAULT_SETTINGS } from './default-settings.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from './platform-settings.model.js';
import { platformSettingsSchema, type PlatformSettings } from './platform-settings.schemas.js';

/** The settings in force: what admins saved, over the launch defaults for anything never saved. */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const record = await PlatformSettingsModel.findById(PLATFORM_SETTINGS_ID).lean();
  return resolveSettings(record?.settings);
}

export function resolveSettings(saved: unknown): PlatformSettings {
  return platformSettingsSchema.parse(mergeDeep(DEFAULT_SETTINGS, saved));
}

/**
 * Saves the launch defaults if nothing is saved yet, so admins start from real values. Never overwrites
 * saved settings. Returns true when it created them.
 */
export async function ensurePlatformSettings(): Promise<boolean> {
  const now = new Date();
  const result = await PlatformSettingsModel.updateOne(
    { _id: PLATFORM_SETTINGS_ID },
    { $setOnInsert: { settings: DEFAULT_SETTINGS, createdAt: now, updatedAt: now } },
    // Timestamps would also touch updatedAt when the settings already exist.
    { upsert: true, timestamps: false },
  );
  return result.upsertedCount > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Objects merge key by key; anything else (values, lists) in `override` replaces what's in `base`. */
function mergeDeep(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = mergeDeep(base[key], value);
  return merged;
}
