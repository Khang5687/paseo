import { createContext, useContext } from "react";
import { DEFAULT_THEME_PREFERENCE, type AppSettings } from "@/hooks/use-settings";
import type { PluginThemeOption } from "@/plugins/themes";
import { PLUGIN_THEME_PREFERENCE, REGISTERED_THEMES, THEME_TO_UNISTYLES } from "@/styles/theme";
import type { SkinScheme } from "./types";

interface ResolveSchemeInput {
  preference: AppSettings["theme"];
  contributedTheme: PluginThemeOption | null;
  /** The OS color scheme; only used by the `auto` preference. */
  systemScheme: "light" | "dark" | "unspecified" | null | undefined;
}

/**
 * The color scheme the app theme resolves to, mirroring `applyTheme` in the appearance
 * provider, so skins can follow it without subscribing to Unistyles.
 */
export function resolveActiveScheme({
  preference,
  contributedTheme,
  systemScheme,
}: ResolveSchemeInput): SkinScheme {
  if (contributedTheme) return contributedTheme.theme.colorScheme;
  const builtIn = preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtIn === "auto") return systemScheme === "dark" ? "dark" : "light";
  return REGISTERED_THEMES[THEME_TO_UNISTYLES[builtIn]].colorScheme;
}

export const SkinSchemeContext = createContext<SkinScheme | null>(null);

/** The active theme's color scheme. Requires `AppearanceProvider`. */
export function useActiveSkinScheme(): SkinScheme {
  const scheme = useContext(SkinSchemeContext);
  if (scheme === null) throw new Error("useActiveSkinScheme requires AppearanceProvider");
  return scheme;
}
