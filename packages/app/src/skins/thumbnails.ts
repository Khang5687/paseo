import { useEffect, useMemo, useState } from "react";
import { useInstalledPlugins } from "@/plugins/registry";
import { readCachedSkinImages, useCachedSkins } from "./cache";
import { collectPluginSkins } from "./catalog";

interface ThumbnailEntry {
  key: string;
  uri: string | null;
}

/** Plugin thumbnails as data URIs, keyed by `<skinId>\0<version>`. */
const pluginThumbnails = new Map<string, string | null>();
const pluginThumbnailLoads = new Map<string, Promise<string | null>>();

function loadPluginThumbnail(
  key: string,
  load: (() => Promise<{ base64: string; mimeType: string }>) | undefined,
): Promise<string | null> {
  const running = pluginThumbnailLoads.get(key);
  if (running) return running;
  const task = (async () => {
    if (!load) return null;
    const image = await load();
    const uri = `data:${image.mimeType};base64,${image.base64}`;
    pluginThumbnails.set(key, uri);
    return uri;
  })().finally(() => pluginThumbnailLoads.delete(key));
  pluginThumbnailLoads.set(key, task);
  return task;
}

/**
 * A renderable thumbnail URI for the gallery: the cached `small` image when the skin is on this
 * device, otherwise the plugin's `loadThumbnail` result. Null while loading or unavailable.
 */
export function useSkinThumbnail(id: string): string | null {
  const cachedSkins = useCachedSkins();
  const plugins = useInstalledPlugins();
  const cachedVersion = cachedSkins?.find((meta) => meta.id === id)?.version ?? null;
  const live = useMemo(
    () => collectPluginSkins(plugins).find((skin) => skin.id === id) ?? null,
    [plugins, id],
  );
  const loadContributedThumbnail = live?.contribution.loadThumbnail;
  const liveVersion = live?.contribution.version ?? null;

  let key: string | null = null;
  if (cachedVersion !== null) key = `cache\0${id}\0${cachedVersion}`;
  else if (liveVersion !== null && loadContributedThumbnail) key = `plugin\0${id}\0${liveVersion}`;

  const [entry, setEntry] = useState<ThumbnailEntry | null>(null);

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const settle = (uri: string | null) => {
      if (!cancelled) setEntry({ key, uri });
    };
    const fail = () => settle(null);
    if (cachedVersion !== null) {
      readCachedSkinImages(id).then((images) => settle(images?.small ?? null), fail);
    } else if (pluginThumbnails.has(key)) {
      settle(pluginThumbnails.get(key) ?? null);
    } else {
      loadPluginThumbnail(key, loadContributedThumbnail).then(settle, fail);
    }
    return () => {
      cancelled = true;
    };
  }, [key, id, cachedVersion, loadContributedThumbnail]);

  if (key === null) return null;
  if (entry?.key === key) return entry.uri;
  return pluginThumbnails.get(key) ?? null;
}
