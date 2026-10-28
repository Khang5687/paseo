import { create } from "zustand";
import type { PluginSkinContribution } from "@getpaseo/plugin/client";
import { rememberPluginContributionHost } from "@/plugins/contribution-host";
import { listCachedSkins, writeCachedSkin } from "./cache";
import { setSkinSelection } from "./preferences-store";
import type { SkinFocal, SkinIntensity, SkinMetadata } from "./types";

// This module must not import the plugin registry: `plugins/evaluate.ts` imports it to implement
// `client.applySkin`, and the registry imports `evaluate.ts`.

export const DEFAULT_SKIN_INTENSITY: SkinIntensity = { home: 1, workspace: 0.6, utility: 0.8 };
export const CENTER_FOCAL: SkinFocal = { x: 0.5, y: 0.5 };

/** Skins being fetched into the cache, and why the last attempt for an id failed. */
interface SkinLoadState {
  pending: Record<string, true>;
  failures: Record<string, string>;
}

export const useSkinLoadStore = create<SkinLoadState>()(() => ({ pending: {}, failures: {} }));

export function markSkinPending(id: string): void {
  useSkinLoadStore.setState((state) => {
    const { [id]: _failure, ...failures } = state.failures;
    return { pending: { ...state.pending, [id]: true }, failures };
  });
}

/** Clears the pending mark; `error` other than null records why the fetch failed. */
export function markSkinSettled(id: string, error: unknown): void {
  let failure: string | null = null;
  if (error instanceof Error) failure = error.message;
  else if (error !== null) failure = String(error);
  useSkinLoadStore.setState((state) => {
    const { [id]: _pending, ...pending } = state.pending;
    return {
      pending,
      failures: failure === null ? state.failures : { ...state.failures, [id]: failure },
    };
  });
}

function buildPluginMetadata(
  id: string,
  contribution: PluginSkinContribution,
  createdAt: number,
): SkinMetadata {
  return {
    id,
    source: "plugin",
    version: contribution.version,
    name: contribution.name,
    appearance: contribution.appearance,
    focal: contribution.focal ?? CENTER_FOCAL,
    intensity: { ...DEFAULT_SKIN_INTENSITY, ...contribution.intensity },
    luminance: contribution.luminance ?? null,
    attribution: contribution.attribution ?? null,
    createdAt,
  };
}

const inFlightCaches = new Map<string, Promise<SkinMetadata>>();

/** Copies a plugin skin to this device unless the cached copy already has the same version. */
export async function cachePluginSkin(
  id: string,
  contribution: PluginSkinContribution,
): Promise<SkinMetadata> {
  const key = `${id}\0${contribution.version}`;
  const running = inFlightCaches.get(key);
  if (running) return running;
  const task = (async () => {
    const existing = (await listCachedSkins()).find((meta) => meta.id === id);
    if (existing && existing.version === contribution.version) return existing;
    const image = await contribution.loadImage();
    return writeCachedSkin(
      buildPluginMetadata(id, contribution, existing?.createdAt ?? Date.now()),
      { kind: "base64", base64: image.base64, mimeType: image.mimeType },
    );
  })().finally(() => inFlightCaches.delete(key));
  inFlightCaches.set(key, task);
  return task;
}

export async function applyPluginSkin(input: {
  id: string;
  serverId: string | null;
  contribution: PluginSkinContribution;
}): Promise<void> {
  if (input.serverId) rememberPluginContributionHost(input.id, input.serverId);
  await cachePluginSkin(input.id, input.contribution);
  setSkinSelection(input.id, "both");
}
