import { useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { describeSavedFiles, type SavedFileItem, type SavedProjectRoot } from "./saved-list";
import type { OfflineFile } from "./store";

/**
 * Every host's project folders as one string, `serverId\tpath\tname` per line. A string compares
 * by value, so the Saved list renders again only when a folder changes, not on every agent update.
 */
function projectRootLines(sessions: Record<string, SessionState>): string {
  const lines: string[] = [];
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const project of session.projects.values()) {
      const name = project.projectCustomName ?? project.projectDisplayName;
      lines.push(`${serverId}\t${project.projectRootPath}\t${name}`);
    }
    for (const workspace of session.workspaces.values()) {
      const name = workspace.projectCustomName ?? workspace.projectDisplayName;
      lines.push(`${serverId}\t${workspace.projectRootPath}\t${name}`);
      lines.push(`${serverId}\t${workspace.workspaceDirectory}\t${name}`);
    }
  }
  return lines.join("\n");
}

/**
 * The saved files with their project and device names. Projects come from the folders each host
 * reported while connected (project roots and workspace folders); a host the app has not loaded
 * leaves its files named by their folder.
 */
export function useSavedFileItems(files: readonly OfflineFile[]): SavedFileItem[] {
  const hosts = useHosts();
  const rootLines = useSessionStore((state) => projectRootLines(state.sessions));
  const hostLabels = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );
  const rootsByServer = useMemo(() => {
    const result = new Map<string, SavedProjectRoot[]>();
    for (const line of rootLines ? rootLines.split("\n") : []) {
      const [serverId = "", path = "", name = ""] = line.split("\t");
      const roots = result.get(serverId);
      if (roots) roots.push({ path, name });
      else result.set(serverId, [{ path, name }]);
    }
    return result;
  }, [rootLines]);
  return useMemo(
    () => describeSavedFiles(files, { rootsByServer, hostLabels }),
    [files, rootsByServer, hostLabels],
  );
}
