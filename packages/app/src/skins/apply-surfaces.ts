import { UnistylesRuntime } from "react-native-unistyles";
import { REGISTERED_THEMES, type Theme } from "@/styles/theme";
import { computeGateAlpha, parseColor } from "./contrast";
import type { SkinLuminance } from "./types";

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES) as (keyof typeof REGISTERED_THEMES)[];

const TARGET_CONTRAST = 4.5;
const TARGET_CONTRAST_MORE = 7;

type CanvasToken = "canvas" | "canvasSidebar" | "canvasWorkspace" | "canvasScrim";

export interface SkinSurfacesInput {
  /** Measured art luminance; null assumes the worst case (pure black and pure white). */
  luminance: SkinLuminance | null;
  /** 0–1 fraction of the contrast-safe art visibility. */
  visibility: number;
  showBehindSidebar: boolean;
  showBehindContent: boolean;
  /** The OS asks for more contrast: gate at 7:1 instead of 4.5:1. */
  moreContrast: boolean;
}

function buildCanvasColors(t: Theme, input: SkinSurfacesInput | null): Record<CanvasToken, string> {
  const colors = t.colors;
  if (!input) {
    return {
      canvas: colors.surface0,
      canvasSidebar: colors.surfaceSidebar,
      canvasWorkspace: colors.surfaceWorkspace,
      canvasScrim: "transparent",
    };
  }

  // Page backgrounds nest (stack screen → screen → pane → panel), so translucent page tokens
  // would compound into an opaque stack. Instead every shown area turns transparent and the
  // backdrop draws one scrim, gated so `foregroundMuted` keeps the target contrast over the
  // worst pixel of the art.
  const base = parseColor(colors.surface0);
  const artLuminance =
    t.colorScheme === "dark" ? (input.luminance?.high ?? 1) : (input.luminance?.low ?? 0);
  const gateAlpha = computeGateAlpha({
    text: parseColor(colors.foregroundMuted),
    base,
    artLuminance,
    target: input.moreContrast ? TARGET_CONTRAST_MORE : TARGET_CONTRAST,
  });
  const visibility = Math.min(1, Math.max(0, input.visibility));
  // Round up so the published alpha never falls below the gate.
  const alpha = Math.ceil((1 - (1 - gateAlpha) * visibility) * 1000) / 1000;
  return {
    canvas: input.showBehindContent ? "transparent" : colors.surface0,
    canvasSidebar: input.showBehindSidebar ? "transparent" : colors.surfaceSidebar,
    canvasWorkspace: input.showBehindContent ? "transparent" : colors.surfaceWorkspace,
    canvasScrim: `rgba(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)}, ${alpha})`,
  };
}

/**
 * Patch every registered Unistyles theme's `canvas*` tokens. With `input`, shown areas turn
 * transparent and `canvasScrim` becomes `surface0` at the smallest alpha that keeps
 * `foregroundMuted` readable over the art, relaxed by `visibility`. With `null`, the page
 * tokens return to their opaque base and the scrim to transparent.
 * Always derived from the base surface tokens (never from the current canvas values), so it
 * is idempotent and safe to re-run after the theme slot is replaced. The active theme is
 * patched first, as `applyAppearance` does, so subscribers see the new tokens in one render.
 */
export function applySkinSurfaces(input: SkinSurfacesInput | null): void {
  const activeTheme = UnistylesRuntime.themeName;
  const themeKeys = activeTheme
    ? [activeTheme, ...ALL_THEME_KEYS.filter((key) => key !== activeTheme)]
    : ALL_THEME_KEYS;

  for (const key of themeKeys) {
    // Branch per scheme like `applyAppearance`: spreading the theme union loses the
    // discriminant and no longer matches either registered theme shape.
    UnistylesRuntime.updateTheme(key, (t) => {
      const canvas = buildCanvasColors(t, input);
      if (t.colorScheme === "light") return { ...t, colors: { ...t.colors, ...canvas } };
      return { ...t, colors: { ...t.colors, ...canvas } };
    });
  }
}
