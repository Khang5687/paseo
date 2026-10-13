import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Copy, ExternalLink, FolderOpen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { isAbsolutePath } from "@/utils/path";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths, type ResolvedWorkspaceFilePaths } from "@/workspace/file-open";
import { useOpenInPreferredEditor } from "@/workspace/open-in-editor/preferred";
import type { InlinePathTarget } from "./parse";
import { useAssistantFileLinkResolverContext } from "./provider";
import { UnresolvedFileLinkError } from "./resolver";

interface FileLinkContextMenuProps {
  fileCandidate: InlinePathTarget;
  resolveFile: () => Promise<InlinePathTarget>;
  children: ReactNode;
}

const TRIGGER_STYLE: ViewStyle = {
  // Same as the tooltip wrapper: RN-web honors "inline-flex", which keeps the link in the
  // paragraph's inline flow.
  display: "inline-flex" as ViewStyle["display"],
};

/**
 * Right-click menu for a file path in an assistant message. Web only: on native a link has no
 * secondary gesture. Links whose absolute host path can't be derived (`~/…`) keep the browser's
 * own menu.
 */
export function FileLinkContextMenu({
  fileCandidate,
  resolveFile,
  children,
}: FileLinkContextMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const { configRef } = useAssistantFileLinkResolverContext();
  const serverId = configRef.current.serverId ?? "";
  const workspaceRoot = configRef.current.workspaceRoot?.trim() ?? "";
  const candidatePaths = resolveFileLinkPaths(fileCandidate.path, workspaceRoot);

  if (!candidatePaths) {
    return children;
  }

  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger contextOnly style={TRIGGER_STYLE}>
        {children}
      </ContextMenuTrigger>
      {open ? (
        <FileLinkContextMenuContent
          serverId={serverId}
          workspaceRoot={workspaceRoot}
          canCopyRelativePath={candidatePaths.relativePath !== null}
          resolveFile={resolveFile}
        />
      ) : null}
    </ContextMenu>
  );
}

/**
 * Null when the path has no absolute form on the host. Without a workspace root an absolute
 * path still resolves, just with no relative form.
 */
function resolveFileLinkPaths(
  path: string,
  workspaceRoot: string,
): ResolvedWorkspaceFilePaths | null {
  if (!isAbsolutePath(path)) {
    return null;
  }
  const workspacePaths = workspaceRoot ? resolveWorkspaceFilePaths({ path, workspaceRoot }) : null;
  return workspacePaths ?? { absolutePath: path, relativePath: null };
}

interface ResolvedFileLink {
  target: InlinePathTarget;
  paths: ResolvedWorkspaceFilePaths;
}

interface FileLinkContextMenuContentProps {
  serverId: string;
  workspaceRoot: string;
  /** Decided from the pre-lookup candidate: a daemon lookup only ever resolves inside the root. */
  canCopyRelativePath: boolean;
  resolveFile: () => Promise<InlinePathTarget>;
}

const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedFolderOpen = withUnistyles(FolderOpen);
const ThemedCopy = withUnistyles(Copy);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const openInEditorIcon = (
  <ThemedExternalLink size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const revealIcon = <ThemedFolderOpen size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />;
const copyIcon = <ThemedCopy size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />;

function FileLinkContextMenuContent({
  serverId,
  workspaceRoot,
  canCopyRelativePath,
  resolveFile,
}: FileLinkContextMenuContentProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const hasWorkspace = workspaceRoot.length > 0;
  const preferredEditor = useOpenInPreferredEditor({
    serverId,
    workspaceDirectory: workspaceRoot,
  });
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution: isLocalDaemon });
  const fileManagerTarget = useMemo(
    () => targets.find((target) => target.kind === "file-manager") ?? null,
    [targets],
  );
  const editor = hasWorkspace ? preferredEditor : null;
  const fileManager = hasWorkspace ? fileManagerTarget : null;

  // Ambiguous tokens are looked up when the action runs, so every action works on the
  // daemon-resolved path. Hovering the link has usually cached that lookup already.
  const withResolvedFile = useCallback(
    (action: (file: ResolvedFileLink) => Promise<void> | void) => {
      const run = async () => {
        let target: InlinePathTarget;
        try {
          target = await resolveFile();
        } catch (error) {
          if (error instanceof UnresolvedFileLinkError) {
            toast.error(t("common.errors.noFileFound", { token: error.token }));
            return;
          }
          throw error;
        }
        const paths = resolveFileLinkPaths(target.path, workspaceRoot);
        if (!paths) {
          toast.error(t("common.errors.noFileFound", { token: target.raw }));
          return;
        }
        await action({ target, paths });
      };
      void run();
    },
    [resolveFile, t, toast, workspaceRoot],
  );

  const copy = useCallback(
    async (value: string) => {
      try {
        await Clipboard.setStringAsync(value);
        toast.copied(t("workspace.tabs.toasts.filePathCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [t, toast],
  );

  const handleOpenInEditor = useCallback(() => {
    withResolvedFile(({ target, paths }) => {
      if (!editor) {
        return;
      }
      editor.openFile({ path: paths.absolutePath, lineStart: target.lineStart });
    });
  }, [editor, withResolvedFile]);

  const handleReveal = useCallback(() => {
    withResolvedFile(async ({ paths }) => {
      if (!fileManager) {
        return;
      }
      try {
        await openDesktopTarget({
          editorId: fileManager.id,
          workspacePath: workspaceRoot,
          filePath: paths.absolutePath,
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    });
  }, [fileManager, t, toast, withResolvedFile, workspaceRoot]);

  const handleCopyRelativePath = useCallback(() => {
    withResolvedFile(async ({ paths }) => {
      if (paths.relativePath === null) {
        return;
      }
      await copy(paths.relativePath);
    });
  }, [copy, withResolvedFile]);

  const handleCopyFullPath = useCallback(() => {
    withResolvedFile(({ paths }) => copy(paths.absolutePath));
  }, [copy, withResolvedFile]);

  const hasLaunchActions = editor !== null || fileManager !== null;

  return (
    <ContextMenuContent align="start" width={220} testID="assistant-file-link-context-menu">
      {editor ? (
        <ContextMenuItem
          testID="assistant-file-link-open-in-editor"
          leading={openInEditorIcon}
          onSelect={handleOpenInEditor}
        >
          {t("workspace.fileActions.openIn", { target: editor.targetName })}
        </ContextMenuItem>
      ) : null}
      {fileManager ? (
        <ContextMenuItem
          testID="assistant-file-link-reveal"
          leading={revealIcon}
          onSelect={handleReveal}
        >
          {t("workspace.fileActions.revealIn", { target: fileManager.label })}
        </ContextMenuItem>
      ) : null}
      {hasLaunchActions ? <ContextMenuSeparator /> : null}
      {canCopyRelativePath ? (
        <ContextMenuItem
          testID="assistant-file-link-copy-relative-path"
          leading={copyIcon}
          onSelect={handleCopyRelativePath}
        >
          {t("workspace.fileActions.copyRelativePath")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        testID="assistant-file-link-copy-full-path"
        leading={copyIcon}
        onSelect={handleCopyFullPath}
      >
        {t("workspace.fileActions.copyFullPath")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
