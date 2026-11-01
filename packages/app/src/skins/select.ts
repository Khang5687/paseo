import { rememberPluginContributionHost } from "@/plugins/contribution-host";
import {
  deleteCachedSkin,
  listCachedSkins,
  updateCachedSkinMetadata,
  writeCachedSkin,
} from "./cache";
import { findLivePluginSkin, summarizeCachedSkin } from "./catalog";
import {
  cachePluginSkin,
  CENTER_FOCAL,
  DEFAULT_SKIN_INTENSITY,
  markSkinPending,
  markSkinSettled,
} from "./plugin-cache";
import {
  getSkinPreferences,
  setSkinPreview,
  setSkinSelection,
  useSkinPreferencesStore,
} from "./preferences-store";
import type { SkinFocal, SkinMetadata, SkinScheme, SkinSchemeTarget, SkinSummary } from "./types";

export { applyPluginSkin } from "./plugin-cache";

const MAX_NAME_LENGTH = 60;
const FALLBACK_LOCAL_NAME = "Custom image";
/** Relative luminance of mid-gray (sRGB 118): art whose luminance midpoint is above it reads as light. */
const LIGHT_ART_LUMINANCE = 0.18;
const LOCAL_PREFIX = "local:";

/** Makes sure `id` is on this device, fetching it from its live plugin contribution when needed. */
async function ensureSkinCached(id: string): Promise<SkinMetadata> {
  const live = findLivePluginSkin(id);
  if (live) {
    rememberPluginContributionHost(id, live.serverId);
    return cachePluginSkin(id, live.contribution);
  }
  const cached = (await listCachedSkins()).find((meta) => meta.id === id);
  if (!cached) throw new Error("This skin is not available on this device.");
  return cached;
}

export async function selectSkin(id: string | null, target: SkinSchemeTarget): Promise<void> {
  if (id !== null) await ensureSkinCached(id);
  setSkinSelection(id, target);
}

export function previewSkin(id: string | null): void {
  setSkinPreview(id);
  if (id === null || !findLivePluginSkin(id)) return;
  markSkinPending(id);
  ensureSkinCached(id).then(
    () => markSkinSettled(id, null),
    (error: unknown) => markSkinSettled(id, error),
  );
}

function nameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^./\\]+$/, "").trim();
  return (withoutExtension || FALLBACK_LOCAL_NAME).slice(0, MAX_NAME_LENGTH).trim();
}

function inferAppearance(meta: SkinMetadata): SkinScheme {
  if (!meta.luminance) return "dark";
  return (meta.luminance.low + meta.luminance.high) / 2 > LIGHT_ART_LUMINANCE ? "light" : "dark";
}

export async function importLocalSkin(file: {
  uri: string;
  name: string;
  mimeType?: string;
}): Promise<SkinSummary> {
  const draft: SkinMetadata = {
    // `polyfillCrypto` installs `crypto.randomUUID` on native at startup; browsers ship it.
    id: `${LOCAL_PREFIX}${globalThis.crypto.randomUUID()}`,
    source: "local",
    version: "1",
    name: nameFromFile(file.name),
    appearance: "dark",
    focal: CENTER_FOCAL,
    intensity: DEFAULT_SKIN_INTENSITY,
    luminance: null,
    attribution: null,
    createdAt: Date.now(),
  };
  const stored = await writeCachedSkin(draft, {
    kind: "uri",
    uri: file.uri,
    mimeType: file.mimeType,
  });
  const appearance = inferAppearance(stored);
  const final =
    appearance === stored.appearance
      ? stored
      : await updateCachedSkinMetadata(stored.id, { appearance });
  return summarizeCachedSkin(final, null);
}

function assertLocalSkin(id: string): void {
  if (!id.startsWith(LOCAL_PREFIX)) throw new Error("Only imported images can be changed here.");
}

export async function updateLocalSkin(
  id: string,
  patch: { name?: string; focal?: SkinFocal; appearance?: SkinScheme },
): Promise<void> {
  assertLocalSkin(id);
  await updateCachedSkinMetadata(id, patch);
}

export async function removeSkin(id: string): Promise<void> {
  assertLocalSkin(id);
  const { selection } = getSkinPreferences();
  if (selection.light === id) setSkinSelection(null, "light");
  if (selection.dark === id) setSkinSelection(null, "dark");
  if (useSkinPreferencesStore.getState().preview === id) setSkinPreview(null);
  await deleteCachedSkin(id);
}
