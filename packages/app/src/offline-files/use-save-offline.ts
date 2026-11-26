import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { getFileNameFromPath } from "@/attachments/utils";
import { FileLinkPickCancelledError } from "@/assistant-file-links/ladder";
import { useAssistantFileLinkResolverContext } from "@/assistant-file-links/provider";
import { classifyForResolution } from "@/assistant-file-links/resolver";
import { resolveFileLinkLookup } from "@/assistant-file-links/use-file-link";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSessionStore } from "@/stores/session-store";
import { withTransferProgress } from "@/stores/download-store";
import { addSavedFile } from "./saver";

/**
 * Saves a chat file link for offline use and reports the result in a toast. Links that are not
 * files do nothing.
 */
export function useSaveFileLinkOffline(): (source: AssistantFileLinkSource) => void {
  const { t } = useTranslation();
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  return useStableEvent((source: AssistantFileLinkSource) => {
    const config = context.configRef.current;
    const { serverId, workspaceRoot = "", relativePathBase, toast } = config;
    const session = serverId ? useSessionStore.getState().sessions[serverId] : undefined;
    if (!serverId || !session?.client) {
      toast?.error(t("workspace.terminal.hostDisconnected"));
      return;
    }
    const resolution = classifyForResolution(source, { workspaceRoot, relativePathBase });
    void (async () => {
      let path: string;
      if (resolution.kind === "needsLookup") {
        try {
          path = (await resolveFileLinkLookup({ resolution, config, context, queryClient })).path;
        } catch (error) {
          if (error instanceof FileLinkPickCancelledError) return;
          toast?.error(t("common.errors.noFileFound", { token: resolution.token }));
          return;
        }
      } else if (resolution.value.kind === "file") {
        path = resolution.value.target.path;
      } else {
        return;
      }
      const result = await withTransferProgress(
        { serverId, scopeId: serverId, fileName: getFileNameFromPath(path) ?? path },
        (onProgress) => addSavedFile({ serverId, workspaceRoot, path, onProgress }),
      );
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
