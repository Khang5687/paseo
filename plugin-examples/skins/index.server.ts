import type { PluginServerContext } from "@getpaseo/plugin/server";
import { renderAurora } from "./server/aurora";
import { skinImageRpc } from "./shared/skin";

export default function contribute(server: PluginServerContext) {
  server.handle(skinImageRpc, ({ size }) => {
    const png = size === "thumbnail" ? renderAurora(512, 288) : renderAurora(1920, 1080);
    return { base64: png.toString("base64"), mimeType: "image/png" as const };
  });
  return () => {};
}
