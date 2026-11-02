import { useEffect, useState, useSyncExternalStore } from "react";
import { createOfflineFileSession, withOfflineRefresh } from "@/offline-files/session";
import type { OfflineFile } from "@/offline-files/store";
import { useSessionStore } from "@/stores/session-store";
import { createDaemonFileSession } from "./daemon-session";
import { FileHandle, type FileHandleSnapshot, type FileSession, type FileTarget } from "./handle";

/**
 * The tab target's file handle, observing while `observing`. Disposed when the target changes.
 * With `offlineCopy` it reads the saved copy instead of the host.
 */
export function useFileHandle(input: {
  serverId: string;
  target: FileTarget | null;
  absolutePath: string;
  observing: boolean;
  offlineCopy?: OfflineFile | null;
}): FileHandle | null {
  const { serverId, target, absolutePath, observing, offlineCopy = null } = input;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
  const workspaceFileEditing = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileEditing === true,
  );
  // COMPAT(fileByteWrites): added in v0.13.0, remove gate after 2027-04-20.
  const fileByteWrites = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.fileByteWrites === true,
  );
  const cwd = target?.cwd ?? null;
  const path = target?.path ?? null;
  const [handle, setHandle] = useState<{ key: string; handle: FileHandle } | null>(null);
  const source = offlineCopy ? `offline:${offlineCopy.savedAt}` : "host";
  const key = (client || offlineCopy) && cwd && path ? `${source}:${cwd}:${path}` : null;

  useEffect(() => {
    let session: FileSession;
    if (cwd && path && offlineCopy) {
      session = createOfflineFileSession(offlineCopy);
    } else if (cwd && path && client) {
      session = withOfflineRefresh(
        createDaemonFileSession(client, { workspaceFileEditing, fileByteWrites }),
        { serverId, path: absolutePath },
      );
    } else {
      setHandle(null);
      return;
    }
    const next = new FileHandle(session, { cwd, path }, absolutePath);
    setHandle({ key: `${source}:${cwd}:${path}`, handle: next });
    return () => next.dispose();
  }, [
    absolutePath,
    client,
    cwd,
    fileByteWrites,
    offlineCopy,
    path,
    serverId,
    source,
    workspaceFileEditing,
  ]);

  const current = handle?.key === key ? handle.handle : null;
  useEffect(() => {
    current?.setObserving(observing);
  }, [current, observing]);
  return current;
}

const LOADING: FileHandleSnapshot = { status: "loading" };
const subscribeNothing = () => () => {};
const getLoading = () => LOADING;

export function useFileHandleSnapshot(handle: FileHandle | null): FileHandleSnapshot {
  return useSyncExternalStore(
    handle?.subscribe ?? subscribeNothing,
    handle?.getSnapshot ?? getLoading,
    handle?.getSnapshot ?? getLoading,
  );
}
