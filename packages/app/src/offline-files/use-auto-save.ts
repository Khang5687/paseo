import { useEffect, useRef } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { collectFileMentions } from "@/components/markdown/source";
import { getAppSettings } from "@/hooks/use-settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { autoSaveOfflineFile } from "./saver";

/**
 * Saves the files an open chat's finished assistant messages link, when automatic saving is on.
 * Each message is scanned once per mount, so only chats the user opens save anything.
 */
export function useOfflineAutoSave(input: {
  serverId: string;
  workspaceRoot: string;
  client: DaemonClient | null;
  items: readonly StreamItem[];
  active: boolean;
}): void {
  const { serverId, workspaceRoot, client, items, active } = input;
  const canStat = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceFileEditing === true,
  );
  const connected = useHostRuntimeIsConnected(serverId);
  const scanned = useRef(new Set<string>());

  useEffect(() => {
    if (!active || !serverId || !client || !connected) return;
    const fresh = items.filter(
      (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
        item.kind === "assistant_message" && !scanned.current.has(item.id),
    );
    if (fresh.length === 0) return;
    void (async () => {
      if (!(await getAppSettings()).offlineFilesAutoSave) return;
      for (const item of fresh) {
        scanned.current.add(item.id);
        for (const path of collectFileMentions(item.text, { workspaceRoot })) {
          void autoSaveOfflineFile({ serverId, client, canStat, workspaceRoot, path });
        }
      }
    })();
  }, [active, canStat, client, connected, items, serverId, workspaceRoot]);
}
