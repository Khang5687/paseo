import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import {
  planWorkspaceOpenTargets,
  type PlanWorkspaceOpenTargetsInput,
} from "@/workspace/open-in-editor/planner";

interface UseOpenInPreferredEditorInput {
  serverId: string;
  workspaceDirectory: string;
}

interface OpenInPreferredEditorAction {
  targetName: string;
  openDirectory: (directoryPath: string) => void;
  openFile: (file: WorkspaceFileLocation) => void;
}

type OpenRequest = Pick<PlanWorkspaceOpenTargetsInput, "directoryPath" | "activeFile">;

/**
 * Opens a directory or file in the user's preferred desktop editor. Null when no editor can be
 * launched for this host: a remote daemon, or a client without the desktop editor bridge.
 */
export function useOpenInPreferredEditor({
  serverId,
  workspaceDirectory,
}: UseOpenInPreferredEditorInput): OpenInPreferredEditorAction | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalDaemon(serverId);
  const { preferredEditorId } = usePreferredEditor();
  const { targets, isAvailable } = useDesktopOpenTargets({ isLocalExecution });
  const editorTargets = useMemo(
    () => targets.filter((target) => target.kind === "editor"),
    [targets],
  );
  const preferredTarget = useMemo(() => {
    const preferredId = resolvePreferredEditorId(
      editorTargets.map((target) => target.id),
      preferredEditorId,
    );
    return editorTargets.find((target) => target.id === preferredId) ?? null;
  }, [editorTargets, preferredEditorId]);

  const open = useCallback(
    (request: OpenRequest, failureMessage: string) => {
      if (!preferredTarget) {
        return;
      }
      const target = planWorkspaceOpenTargets({
        ...request,
        workspaceDirectory,
        desktopTargets: [preferredTarget],
        canUseDesktopBridge: isAvailable,
        isLocalExecution,
      }).find((candidate) => candidate.source === "desktop");
      if (!target) {
        return;
      }
      void openDesktopTarget(target.openInput).catch((cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : failureMessage);
      });
    },
    [isAvailable, isLocalExecution, preferredTarget, toast, workspaceDirectory],
  );

  const openDirectory = useCallback(
    (directoryPath: string) => {
      open({ directoryPath }, t("sidebar.project.actions.openFolderFailed"));
    },
    [open, t],
  );

  const openFile = useCallback(
    (file: WorkspaceFileLocation) => {
      open({ activeFile: file }, t("workspace.git.openInEditor.failedOpen"));
    },
    [open, t],
  );

  return useMemo(
    () => (preferredTarget ? { targetName: preferredTarget.label, openDirectory, openFile } : null),
    [openDirectory, openFile, preferredTarget],
  );
}
