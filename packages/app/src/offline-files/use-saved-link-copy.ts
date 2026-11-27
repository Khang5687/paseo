import type { AssistantFileLinkSource } from "@/assistant-file-links";
import { useAssistantFileLinkResolverContext } from "@/assistant-file-links/provider";
import { classifyForResolution } from "@/assistant-file-links/resolver";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { isAbsolutePath } from "@/utils/path";
import { fileNameFromWebUrl, findSavedLinkCopy, type SavedLinkTarget } from "./link-copy";
import { peekOfflineFiles, type OfflineFile } from "./store";

export interface SavedLinkCopy {
  file: OfflineFile;
  /** True for a web link, false for a host file path. */
  web: boolean;
}

/**
 * Finds the saved copy a chat link should open instead of fetching the file again (see
 * `findSavedLinkCopy`), using the chat's host and workspace to place a file path.
 */
export function useSavedLinkCopy(): (
  source: AssistantFileLinkSource,
  messageAt: number,
) => SavedLinkCopy | null {
  const context = useAssistantFileLinkResolverContext();
  return useStableEvent((source: AssistantFileLinkSource, messageAt: number) => {
    const files = peekOfflineFiles();
    if (!files || files.length === 0) return null;
    const { serverId, workspaceRoot = "", relativePathBase } = context.configRef.current;
    const resolution = classifyForResolution(source, { workspaceRoot, relativePathBase });
    let target: SavedLinkTarget | null = null;
    if (resolution.kind === "needsLookup") {
      if (serverId) target = { kind: "suffix", serverId, suffix: resolution.target.path };
    } else if (resolution.value.kind === "external") {
      const fileName = fileNameFromWebUrl(resolution.value.url);
      if (fileName) target = { kind: "name", fileName };
    } else if (resolution.value.kind === "file" && serverId) {
      const path = buildAbsoluteExplorerPath({
        workspaceRoot,
        entryPath: resolution.value.target.path,
      });
      target = isAbsolutePath(path)
        ? { kind: "path", serverId, path }
        : { kind: "suffix", serverId, suffix: path };
    }
    if (!target) return null;
    const file = findSavedLinkCopy(files, target, messageAt);
    return file ? { file, web: target.kind === "name" } : null;
  });
}
