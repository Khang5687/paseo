import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SKIN_ID, skinImageRpc } from "./shared/skin";

export default function contribute(client: PluginClientContext) {
  // Apps released before skins cannot evaluate addSkin; skip quietly instead of failing the plugin.
  if (typeof client.addSkin !== "function") return () => {};
  const remove = client.addSkin({
    id: SKIN_ID,
    name: "Aurora",
    // Bump when the generated art changes so devices refetch it.
    version: "1",
    appearance: "dark",
    focal: { x: 0.7, y: 0.3 },
    attribution: { author: "Paseo", license: "MIT" },
    loadThumbnail: () => client.rpc(skinImageRpc, { size: "thumbnail" }),
    loadImage: () => client.rpc(skinImageRpc, { size: "full" }),
  });
  return remove;
}
