import { z } from "zod";
import type { SkinBlur, SkinPreferences } from "./types";

export const DEFAULT_SKIN_PREFERENCES: SkinPreferences = {
  selection: { light: null, dark: null },
  visibility: 1,
  blur: "off",
  showBehindSidebar: true,
  showBehindContent: true,
};

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const SELECTION_ID_MAX_LENGTH = 256;

const selectionIdSchema = z.string().min(1).max(SELECTION_ID_MAX_LENGTH).nullable();
const blurSchema = z.enum(["off", "low", "medium", "high"] satisfies SkinBlur[]);

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
