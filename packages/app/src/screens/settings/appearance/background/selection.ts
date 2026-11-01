import type { SkinPreferences, SkinSchemeTarget } from "@/skins";

export type SkinSelection = SkinPreferences["selection"];

/** A card is selected when every scheme the target covers points at it. */
export function isSkinSelected(
  selection: SkinSelection,
  id: string | null,
  target: SkinSchemeTarget,
): boolean {
  if (target === "both") {
    return selection.light === id && selection.dark === id;
  }
  return selection[target] === id;
}

export const VISIBILITY_PERCENT_OPTIONS = [25, 50, 75, 100] as const;
export type VisibilityPercent = (typeof VISIBILITY_PERCENT_OPTIONS)[number];

/** Snaps a stored 0–1 visibility to the nearest offered step. */
export function nearestVisibilityPercent(visibility: number): VisibilityPercent {
  const percent = visibility * 100;
  let best: VisibilityPercent = VISIBILITY_PERCENT_OPTIONS[0];
  for (const option of VISIBILITY_PERCENT_OPTIONS) {
    if (Math.abs(option - percent) < Math.abs(best - percent)) {
      best = option;
    }
  }
  return best;
}

/** File name without its extension, used as the default name of an imported skin. */
export function skinNameFromFileName(
  fileName: string | null | undefined,
  fallback: string,
): string {
  const base = (fileName ?? "").replace(/\.[a-z0-9]+$/i, "").trim();
  return base.length > 0 ? base.slice(0, 60) : fallback;
}

/**
 * Converts a click inside a frame into a 0–1 focal point. The frame is exactly the image's
 * box, so no letterbox math is involved.
 */
export function focalFromPoint(
  point: { x: number; y: number },
  size: { width: number; height: number },
) {
  if (size.width <= 0 || size.height <= 0) {
    return { x: 0.5, y: 0.5 };
  }
  return {
    x: Math.min(1, Math.max(0, point.x / size.width)),
    y: Math.min(1, Math.max(0, point.y / size.height)),
  };
}
