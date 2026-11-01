import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import * as Clipboard from "expo-clipboard";
import { Copy, ExternalLink, FolderOpen } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  useContextMenu,
} from "@/components/ui/context-menu";
import { UnresolvedFileLinkError } from "@/assistant-file-links/resolver";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useOpenInPreferredEditor } from "@/workspace/open-in-editor/preferred";
import { resolveFilePathMenuPaths, type FilePathMenuPaths } from "./paths";

export interface FilePathMenuTarget {
  path: string;
  lineStart?: number;
}

export interface FilePathMenuPoint {
  x: number;
  y: number;
}

/**
 * The host's home directory, used to expand `~/` paths. Null until the host reports it.
 * COMPAT(serverInfoHomeDirectory): daemons before this field leave `~/` paths without a menu.
 */
export function useHostHomeDirectory(serverId: string): string | null {
  return useSessionStore((state) => state.sessions[serverId]?.serverInfo?.homeDirectory ?? null);
}

/**
 * The paths a menu would act on for `path`, or null when it has no absolute form on the host.
 * Surfaces render `FilePathMenu` only when this is non-null.
 */
export function useFilePathMenuPaths(input: {
  serverId: string;
  workspaceRoot: string;
  path: string | null;
}): FilePathMenuPaths | null {
  const homeDirectory = useHostHomeDirectory(input.serverId);
  const { path, workspaceRoot } = input;
  return useMemo(
    () => (path ? resolveFilePathMenuPaths({ path, workspaceRoot, homeDirectory }) : null),
    [path, workspaceRoot, homeDirectory],
  );
}

interface FilePathMenuProps {
  serverId: string;
  workspaceRoot: string;
  /** Paths known before the menu opens; decide which items show. */
  paths: FilePathMenuPaths;
  /**
   * The file an action runs on. Ambiguous paths are looked up here, when an action runs, so every
   * action uses the daemon-resolved path. Defaults to `paths.absolutePath`.
   */
  resolveTarget?: () => Promise<FilePathMenuTarget>;
  /** Receives a function that opens the menu at a screen point. */
  children: (openAtPoint: (point: FilePathMenuPoint) => void) => ReactNode;
}

/**
 * Open in editor, reveal in the file manager, and copy actions for a file path the agent
 * mentioned. A long press opens it as a sheet on a compact layout; a right click opens it as a
 * popover at the pointer.
 */
export function FilePathMenu({
  serverId,
  workspaceRoot,
  paths,
  resolveTarget,
  children,
}: FilePathMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <FilePathMenuChildren>{children}</FilePathMenuChildren>
      {open ? (
        <FilePathMenuContent
          serverId={serverId}
          workspaceRoot={workspaceRoot}
          paths={paths}
          resolveTarget={resolveTarget}
        />
      ) : null}
    </ContextMenu>
  );
}

function FilePathMenuChildren({
  children,
}: {
  children: FilePathMenuProps["children"];
}): ReactNode {
  const { setAnchorRect, setOpen } = useContextMenu();
  const openAtPoint = useCallback(
    (point: FilePathMenuPoint) => {
      setAnchorRect({ x: point.x, y: point.y, width: 0, height: 0 });
      setOpen(true);
    },
    [setAnchorRect, setOpen],
  );
  return children(openAtPoint);
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

interface ResolvedFilePath {
  target: FilePathMenuTarget;
  paths: FilePathMenuPaths;
}

function FilePathMenuContent({
  serverId,
  workspaceRoot,
  paths: candidatePaths,
  resolveTarget,
}: Omit<FilePathMenuProps, "children">): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const homeDirectory = useHostHomeDirectory(serverId);
  const hasWorkspace = workspaceRoot.trim().length > 0;
  // A file mentioned in chat or a terminal has no project id, so this opens in the default editor
  // rather than the project-specific one the Explorer remembers.
  const preferredEditor = useOpenInPreferredEditor({
    serverId,
    workspaceDirectory: workspaceRoot,
    projectId: null,
  });
  const isLocalDaemon = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution: isLocalDaemon });
  const fileManager = useMemo(
    () => targets.find((target) => target.kind === "file-manager") ?? null,
    [targets],
  );
  const editor = hasWorkspace ? preferredEditor : null;

  const withResolvedFile = useCallback(
    (action: (file: ResolvedFilePath) => Promise<void> | void) => {
      const run = async () => {
        let target: FilePathMenuTarget;
        try {
          target = resolveTarget ? await resolveTarget() : { path: candidatePaths.absolutePath };
        } catch (error) {
          if (error instanceof UnresolvedFileLinkError) {
            toast.error(t("common.errors.noFileFound", { token: error.token }));
            return;
          }
          throw error;
        }
        const paths = resolveFilePathMenuPaths({ path: target.path, workspaceRoot, homeDirectory });
        if (!paths) {
          toast.error(t("common.errors.noFileFound", { token: target.path }));
          return;
        }
        await action({ target, paths });
      };
      void run();
    },
    [candidatePaths.absolutePath, homeDirectory, resolveTarget, t, toast, workspaceRoot],
  );

  const copy = useCallback(
    async (value: string, label: string) => {
      try {
        await Clipboard.setStringAsync(value);
        toast.copied(label);
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [t, toast],
  );

  const handleOpenInEditor = useCallback(() => {
    withResolvedFile(({ target, paths }) => {
      editor?.openFile({ path: paths.absolutePath, lineStart: target.lineStart });
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
          // The file manager reveals `filePath`; the workspace only has to exist.
          workspacePath: hasWorkspace ? workspaceRoot : paths.absolutePath,
          filePath: paths.absolutePath,
        });
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      }
    });
  }, [fileManager, hasWorkspace, t, toast, withResolvedFile, workspaceRoot]);

  const handleCopyFileName = useCallback(() => {
    withResolvedFile(({ paths }) =>
      copy(paths.fileName, t("workspace.tabs.toasts.fileNameCopiedLabel")),
    );
  }, [copy, t, withResolvedFile]);

  const handleCopyRelativePath = useCallback(() => {
    withResolvedFile(async ({ paths }) => {
      if (paths.relativePath === null) {
        return;
      }
      await copy(paths.relativePath, t("workspace.tabs.toasts.filePathCopiedLabel"));
    });
  }, [copy, t, withResolvedFile]);

  const handleCopyFullPath = useCallback(() => {
    withResolvedFile(({ paths }) =>
      copy(paths.absolutePath, t("workspace.tabs.toasts.filePathCopiedLabel")),
    );
  }, [copy, t, withResolvedFile]);

  const hasLaunchActions = editor !== null || fileManager !== null;

  return (
    <ContextMenuContent align="start" width={220} testID="file-path-menu">
      {editor ? (
        <ContextMenuItem
          testID="file-path-menu-open-in-editor"
          leading={openInEditorIcon}
          onSelect={handleOpenInEditor}
        >
          {t("workspace.fileActions.openIn", { target: editor.targetName })}
        </ContextMenuItem>
      ) : null}
      {fileManager ? (
        <ContextMenuItem
          testID="file-path-menu-reveal"
          leading={revealIcon}
          onSelect={handleReveal}
        >
          {t("workspace.fileActions.revealIn", { target: fileManager.label })}
        </ContextMenuItem>
      ) : null}
      {hasLaunchActions ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        testID="file-path-menu-copy-file-name"
        leading={copyIcon}
        onSelect={handleCopyFileName}
      >
        {t("workspace.fileActions.copyFileName")}
      </ContextMenuItem>
      {candidatePaths.relativePath !== null ? (
        <ContextMenuItem
          testID="file-path-menu-copy-relative-path"
          leading={copyIcon}
          onSelect={handleCopyRelativePath}
        >
          {t("workspace.fileActions.copyRelativePath")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        testID="file-path-menu-copy-full-path"
        leading={copyIcon}
        onSelect={handleCopyFullPath}
      >
        {t("workspace.fileActions.copyFullPath")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
