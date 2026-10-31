import { useTranslation } from "react-i18next";
import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { useAssistantFileLinkResolverContext } from "@/assistant-file-links/provider";
import { classifyForResolution, fetchDaemonResolution } from "@/assistant-file-links/resolver";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSessionStore } from "@/stores/session-store";
import { saveOfflineFileNow } from "./saver";

/**
 * Saves a chat file link for offline use and reports the result in a toast. Links that are not
 * files do nothing.
 */
export function useSaveFileLinkOffline(): (source: AssistantFileLinkSource) => void {
  const { t } = useTranslation();
  const { configRef, getDirectorySuggestions } = useAssistantFileLinkResolverContext();
  return useStableEvent((source: AssistantFileLinkSource) => {
    const { serverId, workspaceRoot = "", relativePathBase, toast } = configRef.current;
    const session = serverId ? useSessionStore.getState().sessions[serverId] : undefined;
    if (!serverId || !session?.client) {
      toast?.error(t("workspace.terminal.hostDisconnected"));
      return;
    }
    const client = session.client;
    const resolution = classifyForResolution(source, { workspaceRoot, relativePathBase });
    void (async () => {
      let path: string;
      if (resolution.kind === "needsLookup") {
        try {
          path = (
            await fetchDaemonResolution({ ...resolution, workspaceRoot, getDirectorySuggestions })
          ).path;
        } catch {
          toast?.error(t("common.errors.noFileFound", { token: resolution.token }));
          return;
        }
      } else if (resolution.value.kind === "file") {
        path = resolution.value.target.path;
      } else {
        return;
      }
      const result = await saveOfflineFileNow({
        serverId,
        client,
        canStat: session.serverInfo?.features?.workspaceFileEditing === true,
        workspaceRoot,
        path,
      });
      if (result.status === "tooLarge") {
        toast?.error(t("offlineFiles.tooLarge", { size: result.maxFileMb }));
      } else if (result.status === "failed") {
        toast?.error(result.error);
      } else {
        toast?.show(t("offlineFiles.savedToast"), { variant: "success" });
      }
    })();
  });
}
