import { UnistylesRuntime } from "react-native-unistyles";
import { REGISTERED_THEMES, type Theme } from "@/styles/theme";

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES) as (keyof typeof REGISTERED_THEMES)[];

type CanvasToken = "canvas" | "canvasSidebar" | "canvasWorkspace";

/** Which page areas show the art while a skin is drawn. */
export interface SkinSurfacesInput {
  showBehindSidebar: boolean;
  showBehindContent: boolean;
}

function buildCanvasColors(t: Theme, input: SkinSurfacesInput | null): Record<CanvasToken, string> {
  const colors = t.colors;
  // Page backgrounds nest (stack screen → screen → pane → panel), so translucent page tokens
  // would compound into an opaque stack. Shown areas turn fully transparent instead; the
  // backdrop dims the art itself to the contrast-safe opacity.
  return {
    canvas: input?.showBehindContent ? "transparent" : colors.surface0,
    canvasSidebar: input?.showBehindSidebar ? "transparent" : colors.surfaceSidebar,
    canvasWorkspace: input?.showBehindContent ? "transparent" : colors.surfaceWorkspace,
  };
}

/**
 * Patch every registered Unistyles theme's `canvas*` tokens: transparent for the areas a drawn
 * skin shows behind, the opaque base surfaces otherwise or with `null`.
 *
 * Always derived from the base surface tokens, so it is idempotent and safe to re-run after the
 * plugin theme slot is replaced. The active theme is patched first, as `applyAppearance` does,
 * so subscribers see the new tokens in one render.
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
