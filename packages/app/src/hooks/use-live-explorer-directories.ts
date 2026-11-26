import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import { LiveExplorerDirectories } from "@/file-explorer/live-directories";

/**
 * Keeps the open folders of a Files tree current. On a host with
 * `fsDirectorySubscriptions` each open folder is watched and re-listed when its entries
 * change; on every host the open folders re-list when the app comes back to the
 * foreground and when the host reconnects.
 */
export function useLiveExplorerDirectories({
  serverId,
  workspaceRoot,
  openPaths,
  reload,
}: {
  serverId: string;
  workspaceRoot: string;
  /** Folders whose rows are on screen: "." plus every expanded folder with expanded ancestors. */
  openPaths: readonly string[];
  reload: (path: string) => void;
}): void {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(fsDirectorySubscriptions): added after v0.17.4, remove gate after 2027-05-25.
  const canWatch = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fsDirectorySubscriptions === true,
  );
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  const [live, setLive] = useState<LiveExplorerDirectories | null>(null);

  useEffect(() => {
    if (!client || !workspaceRoot) return;
    const next = new LiveExplorerDirectories({
      watch: canWatch
        ? (path, onChange) => client.subscribeDirectory({ cwd: workspaceRoot, path }, onChange)
        : undefined,
      reload: (paths) => {
        for (const path of paths) reloadRef.current(path);
      },
    });
    setLive(next);
    return () => {
      next.dispose();
      setLive((current) => (current === next ? null : current));
    };
  }, [canWatch, client, workspaceRoot]);

  const pathsKey = openPaths.join("\n");
  useEffect(() => {
    live?.setPaths(pathsKey ? pathsKey.split("\n") : []);
  }, [live, pathsKey]);

  const visible = useAppVisible();
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  const wasAway = useRef(false);
  const away = !visible || connectionStatus !== "online";
  useEffect(() => {
    if (away) {
      wasAway.current = true;
      return;
    }
    if (!wasAway.current) return;
    wasAway.current = false;
    live?.reloadAll();
  }, [away, live]);
}
