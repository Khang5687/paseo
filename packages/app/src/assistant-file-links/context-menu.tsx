import type { ReactNode } from "react";
import type { ViewStyle } from "react-native";
import { ContextMenuTrigger } from "@/components/ui/context-menu";
import { FilePathMenu, useFilePathMenuPaths } from "@/file-path-menu/menu";
import type { InlinePathTarget } from "./parse";
import { useAssistantFileLinkResolverContext } from "./provider";

interface FileLinkContextMenuProps {
  fileCandidate: InlinePathTarget;
  resolveFile: () => Promise<InlinePathTarget>;
  children: ReactNode;
}

const TRIGGER_STYLE: ViewStyle = {
  // The trigger sits inside a prose paragraph; "contents" leaves no box, so a long path still
  // wraps across lines like the bare link does.
  display: "contents" as ViewStyle["display"],
};

/**
 * Right-click menu for a file path in an assistant message. Web only: on native a link has no
 * secondary gesture. Links with no absolute host path (a relative path without a workspace, or
 * `~/…` before the host reports its home directory) keep the browser's own menu.
 */
export function FileLinkContextMenu({
  fileCandidate,
  resolveFile,
  children,
}: FileLinkContextMenuProps): ReactNode {
  const { configRef } = useAssistantFileLinkResolverContext();
  const serverId = configRef.current.serverId ?? "";
  const workspaceRoot = configRef.current.workspaceRoot?.trim() ?? "";
  const paths = useFilePathMenuPaths({ serverId, workspaceRoot, path: fileCandidate.path });

  if (!paths) {
    return children;
  }

  return (
    <FilePathMenu
      serverId={serverId}
      workspaceRoot={workspaceRoot}
      paths={paths}
      resolveTarget={resolveFile}
    >
      {() => (
        <ContextMenuTrigger contextOnly style={TRIGGER_STYLE}>
          {children}
        </ContextMenuTrigger>
      )}
    </FilePathMenu>
  );
}
