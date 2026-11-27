import { useEffect, useMemo, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getAppSettings } from "@/hooks/use-settings";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { saveOfflineFile } from "./store";

const MB = 1024 * 1024;

export type HostCopyStatus = "idle" | "loading" | "missing" | "tooLarge";

/** Connected hosts, other than the file's own, that keep copies of other hosts' files. */
function copyHolders(sourceServerId: string): DaemonClient[] {
  const store = getHostRuntimeStore();
  const sessions = useSessionStore.getState().sessions;
  return store.getHosts().flatMap((host) => {
    if (host.serverId === sourceServerId) return [];
    if (sessions[host.serverId]?.serverInfo?.features?.fileCopies !== true) return [];
    if (!isHostRuntimeConnected(store.getSnapshot(host.serverId))) return [];
    const client = store.getClient(host.serverId);
    return client ? [client] : [];
  });
}

/**
 * Looks for a copy another host keeps of a file on an offline host and saves it on this device,
 * where the offline file session picks it up.
 */
export async function fetchHostCopy(input: {
  serverId: string;
  path: string;
}): Promise<Exclude<HostCopyStatus, "idle" | "loading"> | "saved"> {
  const settings = await getAppSettings();
  for (const client of copyHolders(input.serverId)) {
    const copy = await client
      .readFileCopy({ sourceServerId: input.serverId, path: input.path })
      .catch(() => null);
    if (!copy) continue;
    if (copy.bytes.byteLength > settings.offlineFilesMaxFileMb * MB) return "tooLarge";
    await saveOfflineFile({
      serverId: input.serverId,
      path: input.path,
      version: { ...copy, mimeType: copy.mime },
      bytes: copy.bytes,
      limits: settings,
    });
    return "saved";
  }
  return "missing";
}

/**
 * While `enabled`, fetches the copy another host keeps of the file. Asks again when a host
 * connects, since the one holding the copy may still be connecting.
 */
export function useHostCopy(input: {
  serverId: string;
  path: string;
  enabled: boolean;
}): HostCopyStatus {
  const { serverId, path, enabled } = input;
  const hosts = useHosts();
  const serverIds = useMemo(
    () => hosts.map((host) => host.serverId).filter((id) => id !== serverId),
    [hosts, serverId],
  );
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectedKey = serverIds.filter((id) => statuses.get(id) === "online").join("\n");
  const [status, setStatus] = useState<HostCopyStatus>("idle");

  useEffect(() => {
    if (!enabled || !path || !connectedKey) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    void fetchHostCopy({ serverId, path })
      .catch(() => "missing" as const)
      .then((result) => {
        if (!cancelled) setStatus(result === "saved" ? "idle" : result);
        return undefined;
      });
    return () => {
      cancelled = true;
    };
  }, [connectedKey, enabled, path, serverId]);

  return status;
}
