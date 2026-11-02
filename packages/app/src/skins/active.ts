import { useEffect, useMemo, useState } from "react";
import { useForcedColors, useReduceTransparency } from "./accessibility";
import type { SkinSurfacesInput } from "./apply-surfaces";
import { readCachedSkinImages, useCachedSkins } from "./cache";
import { useSkinPreferencesStore, type SkinPreferencesStoreState } from "./preferences-store";
import { useActiveSkinScheme } from "./scheme";
import { useSkinLoadStore } from "./plugin-cache";
import type { SkinImageUris, SkinMetadata, SkinRenderState, SkinScheme } from "./types";

export function useSkinPreferences(): SkinPreferencesStoreState {
  return useSkinPreferencesStore();
}

interface ActiveSkinSelection {
  id: string | null;
  /** Null until the cache lists it. */
  metadata: SkinMetadata | null;
  /** The device cache has not finished its first load. */
  cacheLoading: boolean;
  suppressed: "reduced-transparency" | "forced-colors" | null;
}

function useActiveSkinSelection(scheme: SkinScheme): ActiveSkinSelection {
  const preview = useSkinPreferencesStore((state) => state.preview);
  const selected = useSkinPreferencesStore((state) => state.selection[scheme]);
  const cached = useCachedSkins();
  const forcedColors = useForcedColors();
  const reduceTransparency = useReduceTransparency();
  const id = preview ?? selected;
  const metadata = useMemo(
    () => (id === null ? null : (cached?.find((meta) => meta.id === id) ?? null)),
    [cached, id],
  );
  let suppressed: ActiveSkinSelection["suppressed"] = null;
  if (forcedColors) suppressed = "forced-colors";
  else if (reduceTransparency) suppressed = "reduced-transparency";
  return { id, metadata, cacheLoading: cached === null, suppressed };
}

interface ResolvedImages {
  key: string;
  uris: SkinImageUris | null;
}

export interface ActiveSkin {
  state: SkinRenderState;
  id: string | null;
  error: string | null;
  metadata: SkinMetadata | null;
  /** Present only when `state` is `on`. */
  images: SkinImageUris | null;
}

/** Resolves the skin to draw for `scheme`: the preview, else the selection, with its device-local images. */
export function useActiveSkin(scheme: SkinScheme): ActiveSkin {
  const { id, metadata, cacheLoading, suppressed } = useActiveSkinSelection(scheme);
  const pending = useSkinLoadStore((state) => id !== null && state.pending[id] === true);
  const failure = useSkinLoadStore((state) => (id === null ? null : (state.failures[id] ?? null)));
  const imagesKey = metadata ? `${metadata.id}\0${metadata.version}` : null;
  const [resolved, setResolved] = useState<ResolvedImages | null>(null);

  useEffect(() => {
    if (!metadata || imagesKey === null || suppressed) return;
    let cancelled = false;
    const settle = (uris: SkinImageUris | null) => {
      if (!cancelled) setResolved({ key: imagesKey, uris });
    };
    readCachedSkinImages(metadata.id).then(settle, () => settle(null));
    return () => {
      cancelled = true;
    };
  }, [metadata, imagesKey, suppressed]);

  if (id === null) return { state: "off", id, error: null, metadata: null, images: null };
  if (suppressed) return { state: suppressed, id, error: null, metadata, images: null };
  if (!metadata) {
    if (cacheLoading || pending)
      return { state: "loading", id, error: null, metadata, images: null };
    return {
      state: "error",
      id,
      error: failure ?? "This skin is not available on this device.",
      metadata,
      images: null,
    };
  }
  if (resolved?.key !== imagesKey) {
    return { state: "loading", id, error: null, metadata, images: null };
  }
  if (!resolved.uris) {
    return {
      state: "error",
      id,
      error: "The skin image is missing from this device.",
      metadata,
      images: null,
    };
  }
  return { state: "on", id, error: null, metadata, images: resolved.uris };
}

export function useSkinRenderState(): {
  state: SkinRenderState;
  activeSkinId: string | null;
  error: string | null;
} {
  const { state, id, error } = useActiveSkin(useActiveSkinScheme());
  return { state, activeSkinId: id, error };
}

/**
 * Which page areas the appearance provider should make transparent for the active skin, or null
 * when no art is drawn. Stable while its values are unchanged, so dragging Art visibility never
 * patches the theme. Surfaces stay opaque when the art cannot be drawn (missing images,
 * suppressed by accessibility settings).
 */
export function useSkinSurfaces(scheme: SkinScheme): SkinSurfacesInput | null {
  const { state: renderState, metadata } = useActiveSkin(scheme);
  const showBehindSidebar = useSkinPreferencesStore((state) => state.showBehindSidebar);
  const showBehindContent = useSkinPreferencesStore((state) => state.showBehindContent);
  // `loading` with metadata means the next skin's images are resolving while the backdrop
  // still shows the previous art; keep surfaces clear so they do not flash opaque.
  const active = metadata !== null && (renderState === "on" || renderState === "loading");
  return useMemo(
    () => (active ? { showBehindSidebar, showBehindContent } : null),
    [active, showBehindSidebar, showBehindContent],
  );
}
