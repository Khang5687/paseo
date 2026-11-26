import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import { APP_SETTINGS_KEY, SETTINGS_MIGRATIONS_KEY } from "./keys";
import {
  OFFLINE_FILE_LIMITS,
  type AppSettings,
  type KeyValueStorage,
  type PersistedAppSettings,
} from "./storage";

const AppliedMigrationsSchema = z.strictObject({ applied: z.array(z.string()) });

/**
 * `sendBehavior` defaulted to "interrupt" for the months before steering existed, and defaults
 * are materialized into storage on first load, so a stored "interrupt" cannot be told apart from
 * a deliberate one. This flips every stored "interrupt" to "steer" exactly once; picking
 * "interrupt" afterwards sticks.
 */
const STEER_DEFAULT_MIGRATION = "steer-default";

/** Existing mobile installs materialized the old 15px content default in storage. */
const MOBILE_CONTENT_16_MIGRATION = "mobile-content-16";

/**
 * The Saved library total defaulted to 500 MB and, like every default, was materialized into
 * storage on first load, so a stored 500 cannot be told apart from a deliberate one. This moves
 * every stored 500 to the new 2 GB default exactly once; picking 500 afterwards sticks.
 */
const OFFLINE_TOTAL_2GB_MIGRATION = "offline-total-2gb";
const OLD_OFFLINE_TOTAL_MB = 500;

/**
 * Brings stored settings up to date, returning what the caller should use. Owns both writes so
 * the marker can only ever be written after the settings it describes: a failed marker write
 * leaves the migration to re-run harmlessly, while a failed settings write must leave the marker
 * unwritten or the migration is lost for good.
 */
export async function migrateAppSettings(
  settings: AppSettings,
  storage: KeyValueStorage,
  stored?: PersistedAppSettings,
  options: { native?: boolean } = {},
): Promise<AppSettings> {
  const migrationMarker = await readValidatedJson(
    storage,
    SETTINGS_MIGRATIONS_KEY,
    AppliedMigrationsSchema,
  );
  const applied = new Set(migrationMarker?.applied ?? []);
  let addedMigration = false;

  let migrated = settings;
  if (!applied.has(STEER_DEFAULT_MIGRATION)) {
    migrated =
      migrated.sendBehavior === "interrupt" ? { ...migrated, sendBehavior: "steer" } : migrated;
    applied.add(STEER_DEFAULT_MIGRATION);
    addedMigration = true;
  }

  if (options.native && !applied.has(MOBILE_CONTENT_16_MIGRATION)) {
    migrated = migrated.contentFontSize === 15 ? { ...migrated, contentFontSize: 16 } : migrated;
    applied.add(MOBILE_CONTENT_16_MIGRATION);
    addedMigration = true;
  }

  if (!applied.has(OFFLINE_TOTAL_2GB_MIGRATION)) {
    migrated =
      migrated.offlineFilesMaxTotalMb === OLD_OFFLINE_TOTAL_MB
        ? { ...migrated, offlineFilesMaxTotalMb: OFFLINE_FILE_LIMITS.maxTotalMb.default }
        : migrated;
    applied.add(OFFLINE_TOTAL_2GB_MIGRATION);
    addedMigration = true;
  }

  if (!addedMigration) {
    return settings;
  }

  if (migrated !== settings) {
    const storedSidebarRowItems = stored?.sidebarRowItems ?? {};
    await storage.setItem(
      APP_SETTINGS_KEY,
      JSON.stringify({
        ...stored,
        ...migrated,
        sidebarRowItems: { ...storedSidebarRowItems, ...migrated.sidebarRowItems },
      }),
    );
  }

  await storage.setItem(SETTINGS_MIGRATIONS_KEY, JSON.stringify({ applied: [...applied] }));
  return migrated;
}
