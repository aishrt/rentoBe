import { HttpError } from '../../lib/http-error.js';
import { validate } from '../../lib/validate.js';
import { recordAudit } from '../audit/audit.service.js';
import { UserModel } from '../users/user.model.js';
import { DEFAULT_SETTINGS } from './default-settings.js';
import { PLATFORM_SETTINGS_ID, PlatformSettingsModel } from './platform-settings.model.js';
import {
  platformSettingsSchema,
  type PlatformSettings,
  type PlatformSettingsResponse,
  type PlatformSettingsUpdate,
} from './platform-settings.schemas.js';

/** The settings in force: what admins saved, over the launch defaults for anything never saved. */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const record = await PlatformSettingsModel.findById(PLATFORM_SETTINGS_ID).lean();
  return resolveSettings(record?.settings);
}

export function resolveSettings(saved: unknown): PlatformSettings {
  return platformSettingsSchema.parse(mergeDeep(DEFAULT_SETTINGS, saved));
}

/** The settings in force, with when and by whom they were last saved, for the admin's settings tab. */
export async function getPlatformSettingsForAdmin(): Promise<PlatformSettingsResponse> {
  const record = await PlatformSettingsModel.findById(PLATFORM_SETTINGS_ID).lean();
  const editor = record?.updatedBy
    ? await UserModel.findById(record.updatedBy).select('firstName lastName').lean()
    : null;
  return {
    settings: resolveSettings(record?.settings),
    ...(record && { updatedAt: record.updatedAt.toISOString() }),
    ...(editor && { updatedBy: `${editor.firstName} ${editor.lastName}` }),
  };
}

const sameCodes = (a: { code: string }[], b: { code: string }[]) =>
  a.map((item) => item.code).join() === b.map((item) => item.code).join();

/**
 * An admin changes some groups of settings (plan §6.2). Each group sent replaces the saved one, except
 * `decisions`, where only the decisions sent change. The result is checked as a whole, saved, and
 * written to the audit log with the groups before and after. Everything that uses the settings reads them
 * from the database each time, so the change applies to the next request; bookings already made keep the
 * terms they were made with.
 */
export async function updatePlatformSettings(
  adminId: string,
  update: PlatformSettingsUpdate,
  ip?: string,
): Promise<PlatformSettingsResponse> {
  const current = await getPlatformSettings();
  const next = validate(platformSettingsSchema, mergeDeep(current, update));

  // Listings and checkout refer to tiers and plans by their code, so the set of them can't change here.
  if (!sameCodes(next.cancellation.tiers, current.cancellation.tiers)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      'cancellation.tiers': 'Adding, removing or renaming cancellation tiers needs a code change.',
    });
  }
  if (!sameCodes(next.protectionPlans, current.protectionPlans)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Some details need fixing.', {
      protectionPlans: 'Adding, removing or renaming protection plans needs a code change.',
    });
  }

  await PlatformSettingsModel.updateOne(
    { _id: PLATFORM_SETTINGS_ID },
    { $set: { settings: next, updatedBy: adminId } },
    { upsert: true },
  );

  const changed = (Object.keys(update) as (keyof PlatformSettings)[]).filter(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]),
  );
  if (changed.length > 0) {
    await recordAudit({
      actorId: adminId,
      action: 'settings.update',
      entity: 'platformSettings',
      entityId: changed.join(','),
      before: Object.fromEntries(changed.map((key) => [key, current[key]])),
      after: Object.fromEntries(changed.map((key) => [key, next[key]])),
      ip,
    });
  }
  return getPlatformSettingsForAdmin();
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
