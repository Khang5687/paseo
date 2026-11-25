import { useEffect, useMemo } from "react";
import type { PluginSkinContribution } from "@getpaseo/plugin/client";
import { getPreferredPluginContributionHost } from "@/plugins/contribution-host";
import { pluginRegistry, useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { useCachedSkins } from "./cache";
import { cachePluginSkin, markSkinPending, markSkinSettled } from "./plugin-cache";
import { useSkinPreferencesStore } from "./preferences-store";
import type { SkinMetadata, SkinSummary } from "./types";

export interface LivePluginSkin {
  /** `<pluginId>/skin/<skinId>` */
  id: string;
  serverId: string;
  contribution: PluginSkinContribution;
}

/** Skins contributed by connected plugins. A skin offered by several hosts resolves like plugin themes. */
export function collectPluginSkins(plugins: readonly InstalledPlugin[]): LivePluginSkin[] {
  const targetsById = new Map<string, LivePluginSkin[]>();
  for (const plugin of plugins) {
    for (const contribution of plugin.skins) {
      const id = `${plugin.id}/skin/${contribution.id}`;
      const target = { id, serverId: plugin.serverId, contribution };
      const targets = targetsById.get(id);
      if (targets) targets.push(target);
      else targetsById.set(id, [target]);
    }
  }
  return [...targetsById].map(([id, targets]) => {
    const preferredHost = getPreferredPluginContributionHost(id);
    return targets.find((target) => target.serverId === preferredHost) ?? targets[0];
  });
}

/** Resolves a contributed skin from the live plugin registry, for imperative callers. */
export function findLivePluginSkin(id: string): LivePluginSkin | null {
  return collectPluginSkins(pluginRegistry.getSnapshot()).find((skin) => skin.id === id) ?? null;
}

export function summarizeCachedSkin(meta: SkinMetadata, serverId: string | null): SkinSummary {
  return {
    id: meta.id,
    name: meta.name,
    source: meta.source,
    appearance: meta.appearance,
    focal: meta.focal,
    attribution: meta.attribution,
    cached: true,
    serverId,
    editable: meta.source === "local",
  };
}

function summarizeLiveSkin(skin: LivePluginSkin, cached: boolean): SkinSummary {
  const { contribution } = skin;
  return {
    id: skin.id,
    name: contribution.name,
    source: "plugin",
    appearance: contribution.appearance,
    focal: contribution.focal ?? { x: 0.5, y: 0.5 },
    attribution: contribution.attribution ?? null,
    cached,
    serverId: skin.serverId,
    editable: false,
  };
}

/** Local skins newest first, then contributed plugin skins, then cached plugin skins whose host is offline. */
export function buildSkinCatalog(
  cached: readonly SkinMetadata[],
  live: readonly LivePluginSkin[],
): SkinSummary[] {
  const cachedIds = new Set(cached.map((meta) => meta.id));
  const liveIds = new Set(live.map((skin) => skin.id));
  const newestFirst = (a: SkinMetadata, b: SkinMetadata) => b.createdAt - a.createdAt;
  const local = cached
    .filter((meta) => meta.source === "local")
    .sort(newestFirst)
    .map((meta) => summarizeCachedSkin(meta, null));
  const contributed = live.map((skin) => summarizeLiveSkin(skin, cachedIds.has(skin.id)));
  const offline = cached
    .filter((meta) => meta.source === "plugin" && !liveIds.has(meta.id))
    .sort(newestFirst)
    .map((meta) => summarizeCachedSkin(meta, null));
  return [...local, ...contributed, ...offline];
}

export function useSkinCatalog(): SkinSummary[] {
  const cached = useCachedSkins();
  const plugins = useInstalledPlugins();
  return useMemo(
    () => buildSkinCatalog(cached ?? [], collectPluginSkins(plugins)),
    [cached, plugins],
  );
}

/**
 * Re-fetches a selected plugin skin when its plugin now contributes a different `version`, so a
 * device that cached the old image picks up the new one without the user reselecting it.
 */
export function useRefreshSelectedPluginSkins(): void {
  const cached = useCachedSkins();
  const plugins = useInstalledPlugins();
  const light = useSkinPreferencesStore((state) => state.selection.light);
  const dark = useSkinPreferencesStore((state) => state.selection.dark);
  useEffect(() => {
    if (!cached) return;
    const live = collectPluginSkins(plugins);
    for (const id of new Set([light, dark])) {
      if (id === null) continue;
      const skin = live.find((candidate) => candidate.id === id);
      const meta = cached.find((candidate) => candidate.id === id);
      if (!skin || !meta || meta.version === skin.contribution.version) continue;
      markSkinPending(id);
      cachePluginSkin(id, skin.contribution).then(
        () => markSkinSettled(id, null),
        (error: unknown) => markSkinSettled(id, error),
      );
    }
  }, [cached, plugins, light, dark]);
}
