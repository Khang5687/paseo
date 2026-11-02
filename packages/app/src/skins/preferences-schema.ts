import { z } from "zod";
import type { SkinPreferences } from "./types";

/** Largest blur radius, in px, the Blur control offers. */
export const SKIN_BLUR_MAX = 32;

export const DEFAULT_SKIN_PREFERENCES: SkinPreferences = {
  selection: { light: null, dark: null },
  visibility: 1,
  blur: 0,
  showBehindSidebar: true,
  showBehindContent: true,
};

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampBlurRadius(value: number): number {
  return Math.min(SKIN_BLUR_MAX, Math.max(0, value));
}

const SELECTION_ID_MAX_LENGTH = 256;

// COMPAT(skinBlurPresets): blur was stored as a preset before it became a radius. Added in
// v0.15, remove after 2027-05-01.
const LEGACY_BLUR_RADIUS = { off: 0, low: 8, medium: 16, high: 28 } as const;

const selectionIdSchema = z.string().min(1).max(SELECTION_ID_MAX_LENGTH).nullable();
const blurSchema = z.union([
  z.number().transform(clampBlurRadius),
  z.enum(["off", "low", "medium", "high"]).transform((preset) => LEGACY_BLUR_RADIUS[preset]),
]);

// Each field falls back to its default so one corrupted value never discards the others.
export const skinPreferencesSchema: z.ZodType<SkinPreferences> = z.strictObject({
  selection: z
    .strictObject({
      light: selectionIdSchema.catch(null),
      dark: selectionIdSchema.catch(null),
    })
    .catch(DEFAULT_SKIN_PREFERENCES.selection),
  visibility: z.number().transform(clampUnit).catch(DEFAULT_SKIN_PREFERENCES.visibility),
  blur: blurSchema.catch(DEFAULT_SKIN_PREFERENCES.blur),
  showBehindSidebar: z.boolean().catch(DEFAULT_SKIN_PREFERENCES.showBehindSidebar),
  showBehindContent: z.boolean().catch(DEFAULT_SKIN_PREFERENCES.showBehindContent),
});
