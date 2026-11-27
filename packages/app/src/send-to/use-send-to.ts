import { useCallback } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useSendToStore } from "./store";

/**
 * Opens the "Send to" device picker for an absolute path on a host. Undefined while the host
 * cannot send files to devices, so menus leave the item out.
 */
export function useSendToAction(serverId: string): ((absolutePath: string) => void) | undefined {
  // COMPAT(sendToDevice): added in v0.16.2, remove gate after 2027-06-01.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.sendToDevice === true,
  );
  const open = useCallback(
    (path: string) => useSendToStore.getState().open({ serverId, path }),
    [serverId],
  );
  return supported ? open : undefined;
}
