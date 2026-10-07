export type SkinScheme = "light" | "dark";
export type SkinSchemeTarget = SkinScheme | "both";
export type SkinBlur = "off" | "low" | "medium" | "high";
export type SkinRoute = "home" | "workspace" | "utility";
export type SkinSource = "local" | "plugin";

export interface SkinFocal {
  /** 0 = left edge, 1 = right edge. */
  x: number;
  /** 0 = top edge, 1 = bottom edge. */
  y: number;
}

export interface SkinIntensity {
  home: number;
  workspace: number;
  utility: number;
}

/** Relative luminance (WCAG, 0–1) of the darkest and brightest 1% of the art's pixels. */
export interface SkinLuminance {
  low: number;
  high: number;
}

export interface SkinAttribution {
  author?: string;
  license?: string;
  sourceUrl?: string;
}

/** Everything about a skin except its pixels. Persisted in the device cache next to the images. */
export interface SkinMetadata {
  /** `local:<uuid>` for imported images, `<pluginId>/skin/<skinId>` for plugin skins. */
  id: string;
  source: SkinSource;
  /** Cache key. A plugin skin whose contribution version differs is re-fetched. */
  version: string;
  name: string;
  appearance: SkinScheme;
  focal: SkinFocal;
  intensity: SkinIntensity;
  luminance: SkinLuminance | null;
  attribution: SkinAttribution | null;
  /** Epoch ms of the first cache write; orders local skins in the gallery. */
  createdAt: number;
}

/** Device-local URIs renderable by expo-image (blob: on web, file:// on native). */
export interface SkinImageUris {
  /** Long side at most 2560 px. */
  display: string;
  /** Long side at most 640 px. Drives blur and gallery thumbnails. */
  small: string;
}

/** One gallery entry: cached skins plus plugin skins not yet copied to this device. */
export interface SkinSummary {
  id: string;
  name: string;
  source: SkinSource;
  appearance: SkinScheme;
  focal: SkinFocal;
  attribution: SkinAttribution | null;
  /** True when the images are in this device's cache. */
  cached: boolean;
  /** Plugin host that contributes the skin; null for local skins. */
  serverId: string | null;
  /** Local skins can be edited and deleted; plugin skins are owned by their plugin. */
  editable: boolean;
}

export interface SkinPreferences {
  /** Active skin per color scheme; null shows no art. */
  selection: Record<SkinScheme, string | null>;
  /** Fraction (0–1) of the contrast-safe maximum art visibility. 1 shows as much art as text contrast allows. */
  visibility: number;
  blur: SkinBlur;
  showBehindSidebar: boolean;
  showBehindContent: boolean;
}

/** Why the active skin is (not) drawn. */
export type SkinRenderState =
  | "off"
  | "loading"
  | "on"
  | "reduced-transparency"
  | "forced-colors"
  | "error";
