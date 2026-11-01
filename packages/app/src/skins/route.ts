import { usePathname } from "expo-router";
import type { SkinRoute } from "./types";

const HOME_PATHS: Record<string, true> = {
  "": true,
  "/": true,
  "/new": true,
  "/welcome": true,
  "/open-project": true,
  "/pair-scan": true,
};
const HOST_PATH = /^\/h\/[^/]+(?:\/(.*))?$/;

/**
 * Workspace routes are the agent chat/terminal screens (`/h/:serverId/workspace/...`,
 * `/h/:serverId/agent/...`). Entry points (root, `/new`, welcome, open-project, host index)
 * are home. Settings, sessions, schedules and plugin screens are utility.
 */
export function classifySkinRoute(pathname: string): SkinRoute {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (HOME_PATHS[path]) return "home";
  const host = HOST_PATH.exec(path);
  if (!host) return "utility";
  const rest = host[1] ?? "";
  if (rest === "" || rest === "open-project") return "home";
  if (rest.startsWith("workspace/") || rest.startsWith("agent/")) return "workspace";
  return "utility";
}

export function useSkinRoute(): SkinRoute {
  return classifySkinRoute(usePathname());
}
